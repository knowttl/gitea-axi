import { collect, object, read } from './api.js';
import type { Row } from './api.js';
import { CliError } from './error.js';
import { boundedList, positive } from './reads.js';
import type { Options } from './reads.js';
import { optionalRead } from './repo-workflows.js';
import type { Client } from './transport.js';
import type { WritePlan } from './writes.js';

const usage = (message: string): never => { throw new CliError('USAGE', message, 2); };
const tagPath = (base: string, tag: string) => base + '/tags/' + encodeURIComponent(tag);
async function readTag(client: Client, base: string, tag: string) {
  const value = await optionalRead(client, tagPath(base, tag));
  if (value !== null && object(value).name !== tag) throw new CliError('INVALID_RESPONSE', 'Tag identity differs from the selected tag');
  return value;
}
export function validateRelease(options: Options) {
  if (options.latest !== undefined || options['discussion-category'] !== undefined) throw new CliError('CAPABILITY_GAP', 'Latest and discussion settings are unsupported by the Gitea contract');
  if (options['notes-start-tag'] && !options['generate-notes']) usage('--notes-start-tag requires --generate-notes');
  if (options['fail-on-no-commits'] && !options['generate-notes']) usage('--fail-on-no-commits requires --generate-notes');
  if (options.notes !== undefined && options.body !== undefined || options['notes-file'] !== undefined && options['body-file'] !== undefined) usage('Choose one notes input');
  if (options['notes-from-tag'] && (options['generate-notes'] || options.notes !== undefined || options.body !== undefined || options['notes-file'] !== undefined || options['body-file'] !== undefined)) usage('--notes-from-tag cannot combine with another notes input');
}

export async function releaseRead(client: Client, operation: string, base: string, tag: string | undefined, options: Options) {
  if (operation === 'release list') {
    const page = await collect(client, base + '/releases');
    const items = page.items.filter(row => !(options['exclude-drafts'] && row.draft) && !(options['exclude-pre-releases'] && row.prerelease));
    return boundedList({ ...page, items, total: options['exclude-drafts'] || options['exclude-pre-releases'] ? page.truncated ? null : items.length : page.total }, positive(options.limit, 10, 1000), ['id', 'tag_name', 'name', 'draft', 'prerelease']);
  }
  const release = object(await read(client, base + '/releases/tags/' + encodeURIComponent(tag!)));
  if (release.tag_name !== tag) throw new CliError('INVALID_RESPONSE', 'Release tag identity differs from the selected tag');
  const body = String(release.body ?? ''), limit = options.full ? 80_000 : 1500;
  return { release: { ...release, body: body.slice(0, limit) }, chars: body.length, truncated: body.length > limit,
    ...(body.length > limit ? { help: 'Use gitea-axi release view ' + tag + ' --repo ' + base.split('/').slice(-2).join('/') + ' --full within the output ceiling' } : {}) };
}

async function generatedNotes(client: Client, base: string, target: string, start: string | undefined) {
  const cache = new Map<string, Row>();
  const commit = async (ref: string) => {
    const row = cache.get(ref) ?? object(await read(client, base + '/git/commits/' + encodeURIComponent(ref)));
    if (typeof row.sha !== 'string' || !Array.isArray(row.parents) || typeof object(row.commit).message !== 'string') throw new CliError('INVALID_RESPONSE', 'Notes require commit identities, parents and messages');
    return row;
  };
  const end = await commit(target);
  const history = await collect(client, base + '/commits?sha=' + encodeURIComponent(String(end.sha)));
  if (history.truncated) throw new CliError('INCOMPLETE_READ', 'Notes require the complete target commit history; narrow the release target');
  for (const row of history.items) cache.set(String(row.sha), row);
  const begin = start ? await readTag(client, base, start) : null;
  if (start && !begin) usage('--notes-start-tag must select an existing tag');
  const startSHA = begin ? String(object(object(begin).commit).sha) : null;
  const walk = async (sha: string) => {
    const found = new Map<string, Row>(), pending = [sha];
    while (pending.length) {
      const next = pending.pop()!;
      if (found.has(next)) continue;
      if (found.size >= 1000) throw new CliError('INCOMPLETE_READ', 'Notes exceed the 1000 commit boundary; select a nearer --notes-start-tag');
      const row = await commit(next);
      if (row.sha !== next) throw new CliError('INVALID_RESPONSE', 'Commit identity differs from the requested boundary');
      found.set(next, row);
      pending.push(...(row.parents as unknown[]).map(parent => String(object(parent).sha)));
    }
    return found;
  };
  const all = await walk(String(end.sha));
  if (startSHA && !all.has(startSHA)) usage('--notes-start-tag must be an ancestor of the target');
  const excluded = startSHA ? await walk(startSHA) : new Map<string, Row>();
  const commits = [...all.values()].filter(row => !excluded.has(String(row.sha))).map(row => ({ sha: row.sha, message: String(object(row.commit).message).split('\n')[0] }));
  return { kind: 'local-composite', from: startSHA, to: end.sha, commits,
    body: commits.map(row => '- ' + row.message + ' (' + row.sha + ')').join('\n') };
}

export async function releasePlan(client: Client, operation: string, base: string, tag: string, options: Options): Promise<WritePlan> {
  const path = base + '/releases', detail = path + '/tags/' + encodeURIComponent(tag);
  const current = await optionalRead(client, detail);
  const before: Row = { release: current };
  if (operation === 'release create' && current !== null) throw new CliError('ALREADY_EXISTS', 'A release already exists for the selected tag; use release edit');
  if (operation !== 'release create' && current === null) throw new CliError('NOT_FOUND_OR_HIDDEN', 'The selected release is missing or hidden');
  if (current && object(current).tag_name !== tag) throw new CliError('INVALID_RESPONSE', 'Release identity differs from the selected tag');
  if (operation === 'release delete') {
    const releases = await collect(client, path);
    if (releases.truncated) throw new CliError('INCOMPLETE_READ', 'Release deletion requires a complete release collection');
    before.releases = releases.items;
    const tagState = await readTag(client, base, tag);
    before.tag = tagState;
    return { target: detail, steps: [{ method: 'DELETE', path: detail }], reads: [path], preconditions: before,
      workflow: { path, expected: { tag_name: tag }, absentId: object(current).id, remaining: releases.items.filter(row => row.id !== object(current).id), tag: { path: tagPath(base, tag), before: tagState } } };
  }
  const payload: Row = {};
  for (const [flag, field] of [['title', 'name'], ['body', 'body'], ['draft', 'draft'], ['prerelease', 'prerelease'], ['target', 'target_commitish']]) {
    if (options[flag!] !== undefined) payload[field!] = options[flag!];
  }
  let notes: Awaited<ReturnType<typeof generatedNotes>> | undefined;
  if (operation === 'release create') {
    Object.assign(payload, { tag_name: tag, name: payload.name ?? tag, body: payload.body ?? '', draft: payload.draft ?? false, prerelease: payload.prerelease ?? false });
    const repo = object(await read(client, base)); before.repository = repo;
    const existingTag = await readTag(client, base, tag); before.tag = existingTag;
    if (options['verify-tag'] && !existingTag) usage('--verify-tag requires an existing tag');
    if (options['notes-from-tag']) {
      if (!existingTag) usage('--notes-from-tag requires an existing tag');
      payload.body = object(existingTag).message ?? '';
    }
    payload.target_commitish ??= repo.default_branch;
    if (options['generate-notes']) {
      let start = typeof options['notes-start-tag'] === 'string' ? options['notes-start-tag'] : undefined;
      if (!start) {
        const releases = await collect(client, path);
        if (releases.truncated) throw new CliError('INCOMPLETE_READ', 'Notes require a complete previous-release list');
        const latest = releases.items.filter(row => !row.draft).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        if (latest) start = String(latest.tag_name);
        before.releases = releases.items;
      }
      notes = await generatedNotes(client, base, existingTag ? String(object(object(existingTag).commit).sha) : String(payload.target_commitish), start);
      if (options['fail-on-no-commits'] && notes.commits.length === 0) usage('No commits exist after the selected notes boundary');
      payload.body = [payload.body, notes.body].filter(Boolean).join('\n\n');
      if (!existingTag) payload.target_commitish = notes.to;
      before.notes = notes;
    }
  } else if (!Object.keys(payload).length) usage('Select at least one release field to edit');
  const expected = current ? { ...Object.fromEntries(['id', 'tag_name', 'name', 'body', 'draft', 'prerelease', 'target_commitish'].map(key => [key, object(current)[key]])), ...payload } : payload;
  return { target: detail, steps: [{ method: operation === 'release create' ? 'POST' : 'PATCH', path: current ? path + '/' + object(current).id : path, payload }],
    reads: [detail], preconditions: before, workflow: { path: detail, expected, created: current === null }, ...(notes ? { notes } : {}) };
}
