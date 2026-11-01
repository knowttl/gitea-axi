import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { collect, object, read, validate } from './api.js';
import type { Row } from './api.js';
import { CliError } from './error.js';
import type { Options } from './reads.js';
import type { Client } from './transport.js';
import type { WritePlan, WriteStep } from './writes.js';

export const transferBytes = 10_000_000;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function safeName(name: string) {
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new CliError('UNSAFE_PATH', 'Attachment requires a safe portable basename');
  return name;
}
function attachment(value: unknown) {
  const row = object(value);
  if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || typeof row.uuid !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.uuid) || typeof row.name !== 'string' || !Number.isSafeInteger(row.size) || Number(row.size) < 0) throw new CliError('INVALID_RESPONSE', 'Attachment metadata has invalid identity or size');
  safeName(row.name);
  return row;
}
export async function assetPath(client: Client, base: string, kind: string, selected: string) {
  if (kind !== 'release') {
    await read(client, base + (kind === 'pr' ? '/pulls/' : '/issues/') + selected);
    return base + '/issues/' + selected + '/assets';
  }
  const page = await collect(client, base + '/releases');
  if (page.truncated) throw new CliError('INCOMPLETE_READ', 'Release identity requires a complete collection');
  const release = page.items.find(row => row.tag_name === selected);
  if (!release || !Number.isSafeInteger(release.id) || Number(release.id) <= 0) throw new CliError('NOT_FOUND_OR_HIDDEN', 'The selected release is missing or hidden');
  return base + '/releases/' + release.id + '/assets';
}
async function uploadSteps(path: string, options: Options): Promise<WriteStep[]> {
  const paths = options.file ?? options.attach;
  if (!paths) throw new CliError('USAGE', 'Select at least one --file', 2);
  const files = Array.isArray(paths) ? paths : [paths];
  const names = new Set<string>();
  const steps: WriteStep[] = [];
  for (const value of files) {
    const filePath = String(value), name = safeName(basename(filePath));
    if (names.has(name.toLowerCase())) throw new CliError('UNSAFE_PATH', 'Duplicate attachment basenames are refused');
    names.add(name.toLowerCase());
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(filePath) !== resolve(filePath)) throw new CliError('UNSAFE_PATH', 'Upload must be a regular file without symlinks');
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (!(await file.stat()).isFile()) throw new CliError('UNSAFE_PATH', 'Upload must be a regular file');
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > transferBytes) throw new CliError('TRANSFER_LIMIT', 'Upload exceeds 10000000 bytes');
        chunks.push(chunk);
      }
    } finally { await file.close(); }
    const bytes = Buffer.concat(chunks);
    const type = String(options['content-type'] ?? 'application/octet-stream');
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) throw new CliError('USAGE', 'Select a MIME content type', 2);
    steps.push({ method: 'POST', path, upload: { name, type, size, base64: bytes.toString('base64'), sha256: hash(bytes) } });
  }
  return steps;
}
export async function uploadPlan(client: Client, path: string, options: Options): Promise<WritePlan> {
  const page = await collect(client, path);
  if (page.truncated) throw new CliError('INCOMPLETE_READ', 'Attachment identity requires a complete collection');
  const before = page.items.map(attachment);
  const steps = await uploadSteps(path, options);
  if (steps.some(step => before.some(row => String(row.name).toLowerCase() === step.upload!.name.toLowerCase()))) throw new CliError('ALREADY_EXISTS', 'An attachment has the same basename; choose a distinct name');
  return { target: path, steps, reads: [path], preconditions: before, assets: { path, before } };
}
export async function attachToPlan(client: Client, plan: WritePlan, operation: string, base: string, selected: string | undefined, options: Options): Promise<WritePlan> {
  if (!options.attach) return plan;
  const comment = operation.endsWith(' comment');
  const created = operation.endsWith(' create') || comment;
  if (created) {
    const parent = comment ? plan.steps.findIndex(step => step.path.endsWith('/comments')) : 0;
    const path = base + (comment ? '/issues/comments/0/assets' : operation.startsWith('release ') ? '/releases/0/assets' : '/issues/0/assets');
    return { ...plan, steps: [...plan.steps, ...(await uploadSteps(path, options)).map(step => ({ ...step, assetParent: parent }))], assets: { path, before: [] } };
  }
  const uploads = await uploadPlan(client, await assetPath(client, base, operation.split(' ')[0]!, selected!), options);
  return { ...plan, steps: [...plan.steps, ...uploads.steps], reads: [...plan.reads, ...uploads.reads], preconditions: { ...object(plan.preconditions), attachments: uploads.preconditions }, assets: uploads.assets! };
}
export function verifyUploads(plan: WritePlan, results: unknown[], observations: { path: string; data: unknown }[]) {
  const { path, before } = plan.assets!;
  const after = (observations.find(row => row.path === path)!.data as unknown[]).map(attachment);
  const uploads = plan.steps.flatMap((step, index) => step.upload ? [{ upload: step.upload, result: attachment(validate(path + '/' + object(results[index]).id, results[index])) }] : []);
  if (after.length !== before.length + uploads.length || before.some(row => !after.some(item => item.id === row.id && item.uuid === row.uuid && item.name === row.name && item.size === row.size)) || uploads.some(({ upload, result }) => before.some(row => row.id === result.id) || !after.some(row => row.id === result.id && row.uuid === result.uuid && row.name === upload.name && row.size === upload.size))) throw new CliError('READBACK_MISMATCH', 'Attachment metadata did not confirm the intended uploads');
}
export async function download(client: Client, path: string, options: Options) {
  if (process.platform === 'win32') throw new CliError('CONFIG_INSECURE', 'Native Windows download ACL protection is unavailable');
  if (options['content-type'] !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(String(options['content-type']))) throw new CliError('USAGE', 'Select a MIME content type', 2);
  if (options.output && options.dir) throw new CliError('USAGE', 'Choose --output or --dir', 2);
  if (options['asset-id'] !== undefined && !/^[1-9]\d*$/.test(String(options['asset-id']))) throw new CliError('USAGE', 'Select one positive --asset-id', 2);
  const page = await collect(client, path);
  if (page.truncated) throw new CliError('INCOMPLETE_READ', 'Download selection requires a complete collection');
  const patterns = options.pattern === undefined ? ['*'] : Array.isArray(options.pattern) ? options.pattern.map(String) : [String(options.pattern)];
  const matches = patterns.map(pattern => new RegExp('^' + pattern.split(/([*?])/).map(part => part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'));
  const selected = page.items.filter(row => (options['asset-id'] === undefined || String(row.id) === options['asset-id']) && matches.some(pattern => pattern.test(String(row.name)))).map(attachment);
  if (!selected.length) throw new CliError('NO_MATCHES', 'No attachments match the selected patterns');
  if (new Set(selected.map(row => String(row.name).toLowerCase())).size !== selected.length) throw new CliError('UNSAFE_PATH', 'Duplicate download basenames are refused');
  if (options.sha256 !== undefined && (selected.length !== 1 || !/^[a-f0-9]{64}$/.test(String(options.sha256)))) throw new CliError('USAGE', '--sha256 requires exactly one selected file and a lowercase SHA-256 digest', 2);
  if (options.output && selected.length !== 1) throw new CliError('USAGE', '--output requires exactly one selected attachment', 2);
  const directory = options.output ? dirname(resolve(String(options.output))) : resolve(String(options.dir ?? '.'));
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new CliError('UNSAFE_PATH', 'Download directory must exist without symlinks');
  const completed: Row[] = [];
  for (const selectedRow of selected) {
    const temporary = join(directory, '.gitea-attachment-' + randomUUID() + '.tmp');
    try {
      const row = attachment(await read(client, path + '/' + selectedRow.id));
      if (['id', 'uuid', 'name', 'size'].some(key => row[key] !== selectedRow[key])) throw new CliError('INVALID_RESPONSE', 'Attachment identity changed before download');
      if (Number(row.size) > transferBytes) throw new CliError('TRANSFER_LIMIT', 'Download exceeds 10000000 bytes');
      const destination = join(directory, options.output ? safeName(basename(String(options.output))) : String(row.name));
      const previous = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (previous && (!options.clobber || previous.isSymbolicLink() || !previous.isFile())) throw new CliError('UNSAFE_PATH', 'Destination exists; choose --clobber for a regular file');
      const { bytes, type } = await client.attachment(String(row.uuid), options['content-type'] === undefined ? undefined : String(options['content-type']));
      const sha256 = hash(bytes);
      if (bytes.length !== row.size || options.sha256 && sha256 !== options.sha256) throw new CliError('INTEGRITY_MISMATCH', 'Downloaded bytes differ from the selected size or digest');
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      if (options.clobber) await rename(temporary, destination); else await link(temporary, destination);
      completed.push({ id: row.id, name: row.name, bytes: bytes.length, sha256, content_type: type, path: destination });
    } catch (error) {
      if (!completed.length) throw error;
      throw new CliError('PARTIAL_TRANSFER', 'Completed attachment IDs ' + completed.map(row => row.id).join(',') + '; remaining transfer failed: ' + (error instanceof CliError ? error.code : 'FILE_ERROR'));
    } finally { await rm(temporary, { force: true }); }
  }
  return { downloads: completed };
}
