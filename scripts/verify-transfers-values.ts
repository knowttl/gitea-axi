import './deny-network.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

type Row = Record<string, unknown>;
interface Output { confirmation: string; error: { code: string; reason: string }; items: Row[]; downloads: Row[]; results: Row[] }
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3]!;
const scratch = await mkdtemp(join(tmpdir(), 'gitea-transfers-values-'));
const token = 'CANARY-S4-credential', secret = 'CANARY-S4-secret\nexact bytes " & %';
const deny = '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url));
const bytes = Buffer.from([0, 255, 13, 10, 42, 128, 99]);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const base = '/api/v1/repos/sample/demo';
const values = new Map<string, Map<string, string>>();
const assets = new Map<string, Row[]>();
const contents = new Map<string, Buffer>();
const requests: { method: string; path: string }[] = [];
const assertions: string[] = [];
const issues: Row[] = [{ id: 1, number: 1, title: 'Selected', body: '', state: 'open', labels: [], assignees: [] }];
const comments: Row[] = [];
const release = { id: 10, tag_name: 'v1', target_commitish: 'main', name: 'First', body: '', draft: false, prerelease: false };
let origin = '', foreignOrigin = '', bin = '', mode = '', journal = 0, writes = 0, nextId = 50, foreignRequests = 0;
const foreign = createServer((_request, response) => { foreignRequests++; response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes); });
const upstreamSecrets: { path: string; value: string }[] = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, origin).pathname, method = request.method!;
  requests.push({ method, path });
  assert.equal(request.headers.authorization, 'token ' + token);
  if (path.startsWith('/attachments/')) {
    if (mode === 'partial' && path === '/attachments/' + String(assets.get(base + '/releases/10/assets')!.at(-1)!.uuid)) { response.destroy(); return; }
    if (mode === 'redirect') { response.writeHead(302, { location: foreignOrigin + '/foreign' }).end(); return; }
    const body = mode === 'oversize' ? Buffer.alloc(10_000_001) : contents.get(path.slice('/attachments/'.length))!;
    response.writeHead(200, { 'content-type': mode === 'wrong-type' ? 'text/html' : 'application/octet-stream' });
    if (mode === 'interrupt') { response.write(body.subarray(0, 1)); response.destroy(); return; }
    response.end(body); return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  let data: unknown, status = 200;
  const valueRoute = /^(.*\/actions\/(secrets|variables))(?:\/([^/]+))?$/.exec(path);
  const assetRoute = /^(.*\/assets)(?:\/(\d+))?$/.exec(path);
  if (method !== 'GET') writes++;
  if (method !== 'GET' && (mode === 'permission' || mode === 'attachment-permission' && assetRoute)) status = 403;
  else if (valueRoute) {
    const [, collection, kind, inputName] = valueRoute;
    const name = inputName?.toUpperCase();
    if (!values.has(collection!)) values.set(collection!, new Map([['CONTROL', 'untouched']]));
    const rows = values.get(collection!)!;
    if (method === 'GET') data = name
      ? kind === 'variables' && rows.has(name) ? { name, data: rows.get(name) } : undefined
      : [...rows].map(([name, data]) => kind === 'secrets' ? { name } : { name, data: collection!.startsWith('/api/v1/repos/') ? '' : data });
    else if (method === 'DELETE') { rows.delete(name!); status = 204; }
    else {
      const payload = JSON.parse(body.toString()) as Row;
      if (kind === 'secrets') {
        assert(payload.data === secret, 'Incorrect protected secret bytes');
        upstreamSecrets.push({ path, value: String(payload.data) });
        rows.set(name!, String(payload.data));
        data = { data: payload.data, secret: payload.data };
      } else {
        assert.equal(method, rows.has(name!) ? 'PUT' : 'POST');
        rows.set(name!, mode === 'wrong-value' ? 'wrong' : String(payload.value));
        if (mode === 'changed-control') rows.set('CONTROL', 'changed');
        status = 204;
      }
    }
  } else if (assetRoute) {
    const path = assetRoute[1]!;
    const rows = assets.get(path) ?? [];
    if (method === 'GET') data = assetRoute[2] ? rows.find(row => String(row.id) === assetRoute[2]) : rows;
    else {
      const form = await new Response(body, { headers: { 'content-type': request.headers['content-type']! } }).formData();
      const file = form.get('attachment') as File;
      assert.equal(file.type, 'application/octet-stream');
      const received = Buffer.from(await file.arrayBuffer());
      assert.deepEqual(received, bytes);
      const id = nextId++, uuid = '00000000-0000-4000-8000-' + String(id).padStart(12, '0');
      data = { id, uuid, name: file.name, size: received.length, browser_download_url: 'https://foreign.invalid/never-use' };
      rows.push(data as Row); assets.set(path, rows); contents.set(uuid, received); status = 201;
    }
  } else if (path === base + '/releases') data = [release];
  else if (path === base + '/releases/10') data = release;
  else if (path === base) data = { id: 10, full_name: 'sample/demo', default_branch: 'main' };
  else if (path === '/api/v1/version') data = { version: '1.23.4' };
  else if (path === '/swagger.v1.json') data = { info: { version: '1.23.4' }, paths: { '/version': {} } };
  else if (path === base + '/pulls/1') data = { ...issues[0], head: { sha: 'a'.repeat(40), ref: 'topic' }, base: { sha: 'b'.repeat(40), ref: 'main' } };
  else if (path === base + '/issues') {
    if (method === 'GET') data = issues;
    else { data = { ...issues[0], id: nextId++, number: nextId, ...JSON.parse(body.toString()) }; issues.push(data as Row); status = 201; }
  } else if (path === base + '/issues/1/comments') {
    if (method === 'GET') data = comments;
    else { data = { id: nextId++, body: JSON.parse(body.toString()).body, user: { id: 1, login: 'sample' } }; comments.push(data as Row); status = 201; }
  } else if (path.startsWith(base + '/issues/')) data = issues.find(row => String(row.number) === path.split('/').at(-1));
  if (data === undefined && status === 200) status = 404;
  response.writeHead(status, { 'content-type': 'application/json' }).end(status === 204 ? undefined : JSON.stringify(data ?? {}));
});
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_STATE_HOME: scratch,
  NODE_OPTIONS: deny, GITEA_AXI_TOKEN: JSON.stringify({ env: 'SYNTHETIC_TOKEN' }), SYNTHETIC_TOKEN: token, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true' };
async function run(executable: string, args: string[], expected = 0, input?: string, childEnv: NodeJS.ProcessEnv = process.env, cwd = root) {
  const child = spawn(executable, args, { cwd, env: { ...childEnv, NODE_OPTIONS: deny }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  assert.equal(code, expected, stdout + stderr);
  for (const value of [token, secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert(!(stdout + stderr).includes(value), 'Protected value leaked');
  return stdout;
}
async function invoke(args: string[], expected = 0, input?: string) {
  return decode(await run(process.execPath, [bin, ...args], expected, input, { ...env, GITEA_AXI_WRITE_LOG: join(scratch, 'state-' + journal, 'writes.log') }, scratch)) as unknown as Output;
}
async function execute(args: string[], operation: string, input?: string, expected = 0) {
  const argv = [...args, '--allow-write', operation];
  const preview = await invoke([...argv, '--preview'], 0, input);
  return invoke([...argv, '--confirm', preview.confirmation], expected, input);
}
function expect(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); assertions.push(name); }
async function assertNoSecret(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await assertNoSecret(child);
    else {
      const text = await readFile(child, 'utf8');
      for (const value of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert(!text.includes(value), 'Secret leaked to persisted journal or receipt');
    }
  }
}
let result = 'failed', packageSha256 = '';
let source: { head: string; dirty: boolean } | undefined;
let host: Awaited<ReturnType<typeof readHost>> | undefined;
let fixture: unknown = 'skipped: opt-in frozen Artium fixture required';
try {
  await run('npm', ['run', 'build']);
  source = { head: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), dirty: Boolean((await run('git', ['-C', root, 'status', '--porcelain'])).trim()) };
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string }[];
  const tarball = join(scratch, packed!.filename);
  packageSha256 = digest(await readFile(tarball));
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(scratch, 'installed'), tarball]);
  bin = join(scratch, 'installed/node_modules/@knowttl/gitea-axi/dist/cli.js');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  foreignOrigin = 'http://127.0.0.1:' + (foreign.address() as AddressInfo).port;
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  env.GITEA_AXI_ORIGIN = origin; env.GITEA_AXI_TOKEN_ORIGIN = origin;
  const selected = ['--repo', 'sample/demo'];
  if (task === 'S4.3') {
    const secretFile = join(scratch, 'secret'); await writeFile(secretFile, secret, { mode: 0o600 });
    for (const [scope, selector, secretOp, deleteOp, variableOps] of [
      [base, selected, 'updateRepoSecret', 'deleteRepoSecret', ['createRepoVariable', 'updateRepoVariable', 'deleteRepoVariable']],
      ['/api/v1/orgs/team', ['--org', 'team'], 'updateOrgSecret', 'deleteOrgSecret', ['createOrgVariable', 'updateOrgVariable', 'deleteOrgVariable']],
    ] as const) {
      await execute(['secret', 'set', 'named', ...selector, '--input', '-'], secretOp, secret);
      await execute(['secret', 'set', 'file', ...selector, '--input', secretFile], secretOp);
      await execute(['api', 'PUT', scope + '/actions/secrets/raw', '--input', '-'], secretOp, JSON.stringify({ data: secret }));
      expect('Exact protected values and targets ' + scope, upstreamSecrets.slice(-3).map(row => ({ path: row.path, matches: row.value === secret })), ['NAMED', 'FILE', 'RAW'].map(name => ({ path: scope + '/actions/secrets/' + name, matches: true })));
      const beforeList = writes;
      expect('Secret list exposes names only ' + scope, (await invoke(['secret', 'list', ...selector])).items, [{ name: 'CONTROL' }, { name: 'NAMED' }, { name: 'FILE' }, { name: 'RAW' }]);
      expect('Listing never mutates ' + scope, writes, beforeList);
      await execute(['secret', 'delete', 'named', ...selector], deleteOp);
      expect('Exact secret deletion preserves control ' + scope, [...values.get(scope + '/actions/secrets')!.keys()], ['CONTROL', 'FILE', 'RAW']);
      await execute(['api', 'DELETE', scope + '/actions/secrets/raw'], deleteOp);
      expect('Raw lowercase secret deletion preserves control ' + scope, [...values.get(scope + '/actions/secrets')!.keys()], ['CONTROL', 'FILE']);
      await execute(['variable', 'set', 'value', ...selector, '--body', 'initial'], variableOps[0]);
      expect('Nonempty variable readback and control ' + scope, (await invoke(['variable', 'list', ...selector])).items, [{ name: 'CONTROL', data: 'untouched' }, { name: 'VALUE', data: 'initial' }]);
      const update = ['variable', 'set', 'value', ...selector, '--body=', '--allow-write', variableOps[1]!];
      const variablePreview = await invoke([...update, '--preview']);
      values.get(scope + '/actions/variables')!.set('CONTROL', 'changed');
      expect('Changed control invalidates variable confirmation ' + scope, (await invoke([...update, '--confirm', variablePreview.confirmation], 1)).error.code, 'CONFIRMATION_MISMATCH');
      values.get(scope + '/actions/variables')!.set('CONTROL', 'untouched');
      await execute(['variable', 'set', 'value', ...selector, '--body='], variableOps[1]);
      expect('Empty variable readback and control ' + scope, (await invoke(['variable', 'list', ...selector])).items, [{ name: 'CONTROL', data: 'untouched' }, { name: 'VALUE', data: '' }]);
      await execute(['variable', 'delete', 'value', ...selector], variableOps[2]);
      expect('Variable deletion preserves control ' + scope, [...values.get(scope + '/actions/variables')!], [['CONTROL', 'untouched']]);
    }
    const noDispatch = writes;
    for (const flag of ['--field', '--raw-field']) expect('Secret argv refusal ' + flag, (await invoke(['api', 'PUT', base + '/actions/secrets/ARGV', flag, 'data=' + secret, '--preview', '--allow-write', 'updateRepoSecret'], 1)).error.code, 'CONFIG_INVALID');
    expect('Argv never dispatches', writes, noDispatch);
    const argv = ['secret', 'set', 'BOUND', ...selected, '--input', '-', '--allow-write', 'updateRepoSecret'];
    const preview = await invoke([...argv, '--preview'], 0, secret);
    expect('Changed protected input invalidates confirmation', (await invoke([...argv, '--confirm', preview.confirmation], 1, secret + 'changed')).error.code, 'CONFIRMATION_MISMATCH');
    mode = 'permission'; journal++;
    expect('Secret permission refusal cannot report success', (await execute(['secret', 'set', 'REFUSED', ...selected, '--input', '-'], 'updateRepoSecret', secret, 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = '';
    expect('Raw lowercase secret shares the attempted effect identity', (await invoke(['api', 'PUT', base + '/actions/secrets/refused', '--input', '-', '--allow-write', 'updateRepoSecret', '--preview'], 1, JSON.stringify({ data: secret }))).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = 'wrong-value'; journal++;
    expect('Variable wrong readback cannot report success', (await execute(['variable', 'set', 'BAD', ...selected, '--body', 'expected'], 'createRepoVariable', undefined, 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = 'changed-control'; journal++;
    const controlFailure = await execute(['variable', 'set', 'CONTROL_CHECK', ...selected, '--body', 'expected'], 'createRepoVariable', undefined, 1);
    expect('Variable control change cannot report success', controlFailure.error.code, 'WRITE_OUTCOME_UNKNOWN');
    await assertNoSecret(join(scratch, 'state-0'));
  } else {
    const source = join(scratch, 'payload.bin'); await writeFile(source, bytes);
    const second = join(scratch, 'second.bin'); await writeFile(second, bytes);
    for (const [kind, target, operation, path] of [
      ['issue', '1', 'issueCreateIssueAttachment', base + '/issues/1/assets'],
      ['pr', '1', 'issueCreateIssueAttachment', base + '/issues/1/assets'],
      ['release', 'v1', 'repoCreateReleaseAttachment', base + '/releases/10/assets'],
    ]) {
      if (kind === 'pr') { assets.set(path!, []); journal++; }
      await execute([kind!, 'upload', target!, ...selected, '--file', source], operation!);
      const directory = join(scratch, kind!); await mkdir(directory);
      const command = [kind!, 'download', target!, ...selected, '--dir', directory, '--pattern', '*.bin', '--sha256', digest(bytes), '--content-type', 'application/octet-stream'];
      const output = await invoke(command);
      expect('Exact binary digest and type ' + kind, output.downloads.map(row => [row.sha256, row.content_type]), [[digest(bytes), 'application/octet-stream']]);
      expect('Exact binary bytes ' + kind, await readFile(join(directory, 'payload.bin')), bytes);
      expect('Implicit overwrite refused ' + kind, (await invoke(command, 1)).error.code, 'UNSAFE_PATH');
      await invoke([...command, '--clobber']);
    }
    await execute(['issue', 'comment', '1', ...selected, '--body', 'Attachment comment', '--attach', source], 'issueCreateComment,issueCreateIssueCommentAttachment');
    expect('Comment upload uses created comment identity', assets.get(base + '/issues/comments/' + comments[0]!.id + '/assets')!.map(row => row.name), ['payload.bin']);
    await execute(['issue', 'create', ...selected, '--title', 'With attachment', '--attach', source], 'issueCreateIssue,issueCreateIssueAttachment');
    expect('Issue upload uses created issue identity', assets.get(base + '/issues/' + issues.at(-1)!.number + '/assets')!.map(row => row.name), ['payload.bin']);
    const directory = join(scratch, 'failures'); await mkdir(directory);
    const download = ['release', 'download', 'v1', ...selected, '--dir', directory, '--content-type', 'application/octet-stream'];
    for (const [failure, code] of [['redirect', 'TRANSPORT_ERROR'], ['interrupt', 'TRANSPORT_ERROR'], ['oversize', 'TRANSFER_LIMIT'], ['wrong-type', 'INVALID_RESPONSE']]) {
      mode = failure!;
      expect('Binary failure ' + failure, (await invoke(download, 1)).error.code, code);
      expect('Failed binary leaves no partial file ' + failure, await readdir(directory), []);
    }
    mode = '';
    expect('Redirect target never receives a request or credentials', foreignRequests, 0);
    expect('Independent digest mismatch refuses publication', (await invoke([...download, '--sha256', '0'.repeat(64)], 1)).error.code, 'INTEGRITY_MISMATCH');
    expect('No matching asset is explicit', (await invoke([...download, '--pattern', '*.missing'], 1)).error.code, 'NO_MATCHES');
    const rows = assets.get(base + '/releases/10/assets')!;
    rows.push({ ...rows[0], id: 999 });
    expect('Duplicate basenames refused', (await invoke(download, 1)).error.code, 'UNSAFE_PATH'); rows.pop();
    const originalName = rows[0]!.name; rows[0]!.name = '../escape';
    expect('Traversal metadata refused', (await invoke(download, 1)).error.code, 'UNSAFE_PATH'); rows[0]!.name = originalName;
    await symlink(source, join(directory, 'payload.bin'));
    expect('Symlink destination refused even with clobber', (await invoke([...download, '--clobber'], 1)).error.code, 'UNSAFE_PATH');
    await rm(join(directory, 'payload.bin'));
    await symlink(source, join(scratch, 'link.bin'));
    const beforeUnsafe = writes;
    expect('Symlink upload refused', (await invoke(['issue', 'upload', '1', ...selected, '--file', join(scratch, 'link.bin'), '--allow-write', 'issueCreateIssueAttachment', '--preview'], 1)).error.code, 'UNSAFE_PATH');
    expect('Unsafe upload never dispatches', writes, beforeUnsafe);
    const oversized = join(scratch, 'large.bin'); await writeFile(oversized, Buffer.alloc(10_000_001));
    expect('Upload has an independent byte ceiling', (await invoke(['issue', 'upload', '1', ...selected, '--file', oversized, '--allow-write', 'issueCreateIssueAttachment', '--preview'], 1)).error.code, 'TRANSFER_LIMIT');
    const bound = ['release', 'upload', 'v1', ...selected, '--file', second, '--allow-write', 'repoCreateReleaseAttachment'];
    const preview = await invoke([...bound, '--preview']); await writeFile(second, Buffer.from('changed'));
    expect('Upload confirmation binds exact bytes', (await invoke([...bound, '--confirm', preview.confirmation], 1)).error.code, 'CONFIRMATION_MISMATCH');
    await writeFile(second, bytes);
    await execute(['release', 'upload', 'v1', ...selected, '--file', second], 'repoCreateReleaseAttachment');
    mode = 'partial';
    expect('Partial transfer identifies completed asset', (await invoke(download, 1)).error.code, 'PARTIAL_TRANSFER');
    expect('Only completed file is retained', await readdir(directory), ['payload.bin']);
    mode = 'attachment-permission'; journal++;
    const partial = await execute(['issue', 'create', ...selected, '--title', 'Parent succeeds', '--attach', source], 'issueCreateIssue,issueCreateIssueAttachment', undefined, 1);
    expect('Attachment failure retains created parent identity', [partial.error.code, partial.error.reason.includes('existing parent id=' + issues.at(-1)!.id + ' number=' + issues.at(-1)!.number)], ['WRITE_OUTCOME_UNKNOWN', true]);
    mode = 'permission'; journal++;
    const refused = join(scratch, 'refused.bin'); await writeFile(refused, bytes);
    expect('Upload permission refusal is uncertain', (await execute(['release', 'upload', 'v1', ...selected, '--file', refused], 'repoCreateReleaseAttachment', undefined, 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
  }
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST, 'Frozen fixture manifest required');
    const manifestBytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(String(manifestBytes)) as { fixtureCommit: string };
    const testedHostHead = (await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'rev-parse', 'HEAD'])).trim();
    fixture = { revision: testedHostHead, manifestRevision: manifest.fixtureCommit, manifestSha256: digest(manifestBytes), testedHostHead, testedHostDirty: Boolean((await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'status', '--porcelain'])).trim()) };
    mode = ''; process.env.NODE_OPTIONS = deny;
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token, artifactFixture: task === 'S4.2' });
    if (task === 'S4.3') {
      await host.grantWrites(['updateRepoSecret', 'deleteRepoSecret', 'updateOrgSecret', 'deleteOrgSecret', 'createRepoVariable', 'updateRepoVariable', 'deleteRepoVariable']);
      for (const [selector, operation] of [[selected, 'updateRepoSecret'], [['--org', 'team'], 'updateOrgSecret']] as const) {
        const args = ['secret', 'set', 'HOSTED', ...selector, '--input', '-', '--allow-write', operation];
        const preview = await host.invokeClient([...args, '--preview'], 0, secret) as Output;
        await host.invokeClient([...args, '--confirm', preview.confirmation], 0, secret);
        expect('Hosted secret exact canary', upstreamSecrets.at(-1)!.value === secret, true);
      }
      const args = ['api', 'PUT', base + '/actions/secrets/HOST_RAW', '--input', 'request.json', '--allow-write', 'updateRepoSecret'];
      const input = { files: [{ name: 'request.json', contentBase64: Buffer.from(JSON.stringify({ data: secret })).toString('base64') }] };
      const preview = await host.invoke([...args, '--preview'], 0, input) as Output;
      await host.invoke([...args, '--confirm', preview.confirmation], 0, input);
      expect('Hosted raw protected file exact target', { path: upstreamSecrets.at(-1)!.path, matches: upstreamSecrets.at(-1)!.value === secret }, { path: base + '/actions/secrets/HOST_RAW', matches: true });
      await host.refuse(['secret', 'set', 'BAD', ...selected, '--input', '/etc/passwd', '--preview', '--allow-write', 'updateRepoSecret'], 'UNSUPPORTED_INPUT');
      const variable = ['variable', 'set', 'HOSTED', ...selected, '--body=', '--allow-write', 'createRepoVariable'];
      const variablePreview = await host.invoke([...variable, '--preview'], 0) as Output;
      await host.invoke([...variable, '--confirm', variablePreview.confirmation], 0);
      expect('Hosted empty variable readback', values.get(base + '/actions/variables')!.get('HOSTED'), '');
      const audit = JSON.stringify(await host.api('/v1/admin/audit?tool=gitea-axi&limit=100'));
      for (const value of [secret, JSON.stringify(secret).slice(1, -1), digest(Buffer.from(secret)), digest(Buffer.from(JSON.stringify({ data: secret })))]) assert(!audit.includes(value), 'Protected input leaked to host audit');
    } else {
      await host.grantWrites(['issueCreateIssueAttachment', 'repoCreateReleaseAttachment', 'gitea.release.download']);
      const file = join(scratch, 'host.bin'); await writeFile(file, bytes);
      const args = ['release', 'upload', 'v1', ...selected, '--file', file, '--allow-write', 'repoCreateReleaseAttachment'];
      const preview = await host.invokeClient([...args, '--preview']) as Output;
      await host.invokeClient([...args, '--confirm', preview.confirmation]);
      const row = assets.get(base + '/releases/10/assets')!.at(-1)!;
      expect('Managed upload exact digest', digest(contents.get(String(row.uuid))!), digest(bytes));
      await host.refuse(['release', 'upload', 'v1', ...selected, '--file', '/etc/passwd', '--preview', '--allow-write', 'repoCreateReleaseAttachment'], 'UNSUPPORTED_INPUT');
      await host.refuse(['release', 'download', 'v1', ...selected, '--dir', '/tmp'], 'FLAG_BLOCKED');
      const selection = { operation: 'gitea.release.download', selector: 'sample/demo/v1/' + row.id, type: 'attachment' };
      const directory = join(scratch, 'managed'); await mkdir(directory, { mode: 0o700 });
      const destination = join(directory, 'saved.bin');
      const transferArgs = ['--operation', selection.operation, '--selector', selection.selector, '--type', selection.type, '--destination', destination];
      const transfer = decode(await host.download(transferArgs)) as { transferId: string; confirm: string };
      const saved = await host.download([...transferArgs, '--transfer', transfer.transferId, '--execute', '--confirm', transfer.confirm]);
      expect('Managed client verified save and receipt', [saved.includes('saveOutcome: verified-save'), saved.includes('receipt: confirmed')], [true, true]);
      expect('Managed client saved exact bytes', await readFile(destination), bytes);
      const targetDigest = digest(Buffer.from(destination));
      const request = { selection, targetDigest, transferId: transfer.transferId };
      await host.reauthenticate();
      const cancelled = await host.api<{ transferId: string }>('/v1/transfers/gitea/prepare', 'POST', { selection, targetDigest });
      await host.api('/v1/transfers/gitea/cancel', 'POST', { ...request, transferId: cancelled.transferId });
      expect('Managed artifact custody cleaned after delivery and cancellation', await readdir(join(scratch, 'artifacts')), []);
    }
  }
  result = 'passed';
} finally {
  if (host) await host.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (foreign.listening) await new Promise<void>((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
  const report = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(report, JSON.stringify({ task, result, source, packageSha256, assertions, requests, artium: fixture, artifactHostInspection: host && task === 'S4.2' ? 'Synthetic mount/cgroup evidence through the existing ArtifactStore inspection seam; real tmpfs/cgroup enforcement pending' : null, binaryContract: 'Gitea v1.23.4 source-derived; live commissioning pending', nativeWindows: 'pending' }, null, 2));
  console.log(task + ' ' + result + '; Artium: ' + (host ? result === 'passed' ? 'verified' : 'failed' : fixture) + '; report: ' + report);
  if (result === 'passed') await rm(scratch, { recursive: true, force: true });
  else console.log('Failed fixture retained: ' + scratch);
}
