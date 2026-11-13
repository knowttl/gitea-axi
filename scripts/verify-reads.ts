import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.ts';

interface Output extends Record<string, unknown> {
  repository: { id: number; full_name: string }; identity: { login: string };
  error: { code: string; reason: string }; items: { id: number; number: number }[];
  data: { id: number; version: string; info: { version: string }; access_token: string };
  organization: { name: string }; comments: { body: string }[];
  sections: { labels: { code: string; items: unknown }; runs: { items: unknown } };
  reviews: { comments: { body: string }[] }[]; diff: string;
}
interface RunOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; code?: number;
  cancel?: boolean; cancelEvent?: string; signal?: NodeJS.Signals;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3];
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/S2/reads.json', import.meta.url), 'utf8')) as typeof import('../test/fixtures/S2/reads.json');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const scratch = await mkdtemp(join(tmpdir(), 'gitea-axi-' + task + '-'));
const canary = 'CANARY-S2-"/%-token';
const base = '/api/v1/repos/sample/demo';
const command = ['--repo', 'sample/demo'];
const requests: { method: string | undefined; path: string | undefined }[] = [];
const contentsFile = { name: 'README.md', path: 'README.md', type: 'file', content: 'eA==', encoding: 'base64', target: null, submodule_git_url: null };
const contentsLink = { name: 'link', path: 'link', type: 'symlink', content: null, encoding: null, target: 'README.md', submodule_git_url: null };
const contentsRoot = [{ name: 'src', path: 'src', type: 'dir', content: null, encoding: null, target: null, submodule_git_url: null, download_url: null }];
const contentsDirectory = [{ ...contentsFile, name: 'main.ts', path: 'src/main.ts', content: null, encoding: null }, { ...contentsRoot[0], name: 'nested', path: 'src/nested' }];
const contentsSubmoduleURL = 'https://example.test/api/v1/repos/sample/demo/contents/module';
const contentsSubmodule = { name: 'module', path: 'module', type: 'submodule', content: null, encoding: null, target: null, submodule_git_url: 'https://example.test/module', download_url: null, html_url: null, git_url: null, url: contentsSubmoduleURL, _links: { self: contentsSubmoduleURL, git: null, html: null } };
const nestedContentsFile = { ...contentsFile, name: 'main.ts', path: 'src/main.ts' };
const editorConfig = { indent_style: 'space', indent_size: '2' };
const gitReferences = [{ ref: 'refs/heads/main', object: { sha: 'a'.repeat(40), type: 'commit', url: 'https://example.test/commit' } }];
let mode = 'ok';
let diffText = 'diff --git a/app.ts b/app.ts\n+' + 'x'.repeat(11000);
let renderedChars = 0;
let holdPath = '';
let holdPage = '1';
let heldClosed = false;
let holdBody = false;
let holdAfterPolls = 1;
let watchPullReads = 0;
let bin: string;
let origin: string;
let foreignRequests = 0;
let host: Awaited<ReturnType<typeof readHost>> | undefined;
const report: Record<string, unknown> & { hostedInvocations: number; hostedRefusals: { args: string[]; response: unknown }[] } = { task, channel: 'offline-fake', result: 'failed', hostedInvocations: 0, hostedRefusals: [], fixture: null };
const foreign = createServer((_request, response) => { foreignRequests++; response.end('{}'); });
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  assert.equal(request.headers.authorization, 'token ' + canary);
  const url = new URL(request.url!, origin);
  if (mode === 'held-watch' && url.pathname === base + '/pulls/7') watchPullReads++;
  if (mode === 'held-watch' && watchPullReads >= holdAfterPolls && url.pathname === holdPath && (url.searchParams.get('page') ?? '1') === holdPage) {
    heldClosed = false;
    response.once('close', () => { heldClosed = true; });
    if (holdBody) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
    server.emit('watch-held');
    return;
  }
  if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1:' + (foreign.address() as AddressInfo).port }).end(); return; }
  if (mode === 'html') { response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>failure</h1>'); return; }
  if (/^(401|403|404|429)$/.test(mode)) {
    response.writeHead(Number(mode), { 'content-type': 'application/json', 'retry-after': '999' }).end(JSON.stringify({ message: 'repository scope denied ' + canary })); return;
  }
  if (mode === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }).end('{broken'); return; }
  const paths: Record<string, unknown> = {
    '/api/v1/version': { version: '1.23.4' }, '/swagger.v1.json': { info: { version: '1.23.4' }, paths: { '/version': {} } },
    '/api/v1/user': fixture.user, '/api/v1/orgs/sample': { id: 2, name: 'sample' },
    '/api/v1/repos/search': { ok: true, data: [fixture.repository] }, '/api/v1/orgs/sample/repos': [fixture.repository],
    [base]: fixture.repository, [base + '/issues/1']: fixture.issues[0], [base + '/pulls/7']: fixture.pull,
    [base + '/labels']: [fixture.label], [base + '/milestones']: [fixture.milestone],
    [base + '/releases']: [], [base + '/actions/tasks']: { workflow_runs: [], total_count: 0 },
    [base + '/contents/README.md']: contentsFile, [base + '/contents/link']: contentsLink,
    [base + '/contents']: contentsRoot, [base + '/contents/src']: contentsDirectory, [base + '/contents/module']: contentsSubmodule,
    [base + '/contents/src/main.ts']: nestedContentsFile, [base + '/contents/src/nested']: [],
    [base + '/editorconfig/src/main.ts']: editorConfig, [base + '/git/refs/heads/main']: gitReferences,
    [base + '/pulls']: [fixture.pull], [base + '/issues/7/comments']: fixture.comments, [base + '/issues/1/comments']: fixture.comments,
    [base + '/pulls/7/reviews']: fixture.reviews, [base + '/pulls/7/reviews/12/comments']: fixture.inline,
    [base + '/pulls/7/commits']: fixture.commits, [base + '/pulls/7/files']: fixture.files, [base + '/issues/7/reactions']: fixture.reactions,
    [base + '/commits/abc123/status']: { sha: 'abc123', statuses: fixture.statuses, total_count: 3 },
    [base + '/commits/abc123/statuses']: mode === 'pending' ? [fixture.statuses[2]] : mode === 'passed' ? [fixture.statuses[0]] : mode === 'absent' ? [] : fixture.statuses,
  };
  let body = paths[url.pathname];
  if (mode === 'team-reviewers' && url.pathname === base + '/pulls/7') body = { ...fixture.pull, requested_reviewers: null, requested_reviewers_teams: [{ id: 22, name: 'maintainers' }] };
  if (mode === 'mixed-reviewers' && url.pathname === base + '/pulls/7') body = { ...fixture.pull, requested_reviewers_teams: [{ id: 22, name: 'maintainers' }] };
  if (mode === 'held-watch' && url.pathname.endsWith('/statuses')) {
    body = [fixture.statuses[2]];
    if (holdPage === '2' && watchPullReads >= holdAfterPolls) response.setHeader('link', `<${origin}${url.pathname}?limit=50&page=2>; rel="next"`);
  }
  if (mode === 'invalid-contents' && body && url.pathname.startsWith(base + '/contents')) body = Array.isArray(body) ? body.map(row => ({ ...row, content: 42 })) : { ...body as object, content: 42 };
  if (mode === 'empty-contents' && url.pathname === base + '/contents/src') body = [];
  if (mode === 'invalid-contents-link' && url.pathname === base + '/contents/module') body = { ...contentsSubmodule, _links: { ...contentsSubmodule._links, git: 42 } };
  if (mode === 'invalid-download-url' && url.pathname === base + '/contents/module') body = { ...contentsSubmodule, download_url: 42 };
  if (['many-inline', 'inline-over-limit'].includes(mode) && url.pathname === base + '/pulls/7/reviews/12/comments') body = Array.from({ length: mode === 'many-inline' ? 50 : 1001 }, (_, index) => ({ ...fixture.inline[0], id: 13 + index, body: 'Line ' + index }));
  if (mode === 'inline-hostile' && url.pathname === base + '/pulls/7/reviews/12/comments') response.setHeader('link', `<http://127.0.0.1:${(foreign.address() as AddressInfo).port}${url.pathname}?page=2>; rel="next"`);
  if (url.pathname === base + '/issues') {
    const page = url.searchParams.get('page');
    body = page === '1' ? [fixture.issues[1]] : page === '2' ? [fixture.issues[0]] : [fixture.issues[2], fixture.issues[0]];
    if (page !== '3') response.setHeader('link', `<${origin}${base}/issues?state=all&type=issues&limit=1&page=${Number(page) + 1}>; rel="next"`);
  }
  if (mode === 'empty') {
    if (url.pathname.endsWith('/issues') || url.pathname.endsWith('/pulls') || url.pathname.endsWith('/labels')) { body = []; response.removeHeader('link'); response.setHeader('x-total-count', '0'); }
  }
  if (mode === 'permission-section' && url.pathname.endsWith('/labels')) { response.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"issue scope required"}'); return; }
  if (mode === 'hostile' && url.pathname.endsWith('/issues')) response.setHeader('link', `<http://127.0.0.1:${(foreign.address() as AddressInfo).port}${base}/issues?page=2>; rel="next"`);
  if (mode === 'missing' && url.pathname === base) body = { id: 10, full_name: 'sample/demo' };
  if (mode === 'wrong-type' && url.pathname === base) body = { ...fixture.repository, id: 'ten' };
  if (mode === 'secret' && url.pathname === '/api/v1/version') body = { version: canary + '|' + encodeURIComponent(canary), access_token: 'other-secret' };
  if (mode === 'envelope' && url.pathname.endsWith('/actions/tasks')) body = [];
  if (url.pathname === base + '/pulls/7.diff') { response.writeHead(200, { 'content-type': 'text/plain' }).end(diffText); return; }
  if (body === undefined) { response.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"unknown fake route"}'); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname.endsWith('/statuses')) server.emit('check-read');
});
async function run(executable: string, argv: string[], options: RunOptions = {}) {
  const child = spawn(executable, argv, { cwd: options.cwd ?? scratch, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout ?? 120_000, killSignal: 'SIGKILL' });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  if (options.cancel) server.once(options.cancelEvent ?? 'check-read', () => child.kill(options.signal ?? 'SIGINT'));
  const [code] = await once(child, 'close');
  assert.equal(code, options.code ?? 0, argv.join(' ') + '\n' + stdout + stderr);
  return stdout;
}
let env: NodeJS.ProcessEnv;
const invoke = async (argv: string[], code = 0, extra: NodeJS.ProcessEnv = {}, hosted = true) => {
  const output = await run(process.execPath, [bin, ...argv], { code, env: { ...env, ...extra } });
  renderedChars = output.length;
  for (const form of [canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary)]) assert(!output.includes(form), 'Canary escaped output');
  const result = (argv.includes('--json') ? JSON.parse(output) : decode(output)) as Output;
  if (host && hosted && !argv.includes('--json') && ['repo', 'issue', 'pr', 'label', 'release', 'run', 'api', 'org', '--repo'].includes(argv[0]!) && Object.keys(extra).length === 0) {
    const hosted = await host.invoke(argv[0] === '--repo' ? ['dashboard', ...argv] : argv, code);
    report.hostedInvocations++;
    assert.deepEqual(hosted, result, 'Hosted and standalone read agree: ' + argv.join(' '));
  }
  return result;
};
try {
  await run('npm', ['run', 'build'], { cwd: root });
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root })) as [{ filename: string }];
  report.packageSha256 = createHash('sha256').update(await readFile(join(scratch, packed.filename))).digest('hex');
  report.sourceHead = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
  report.sourceDirty = Boolean((await run('git', ['-C', root, 'status', '--porcelain'])).trim());
  const prefix = join(scratch, 'installed');
  await run('npm', ['install', '--offline', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename)]);
  bin = join(prefix, 'node_modules/@knowttl/gitea-axi/dist/cli.js');
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  env = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: scratch, APPDATA: scratch, XDG_CONFIG_HOME: scratch, GITEA_AXI_ORIGIN: origin,
    GITEA_AXI_TOKEN_ORIGIN: origin, GITEA_AXI_TOKEN: JSON.stringify({ env: 'TEST_TOKEN' }), TEST_TOKEN: canary, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true' };
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST, 'Hosted proof requires GITEA_AXI_ARTIUM_MANIFEST from the frozen fixture');
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(bytes.toString('utf8')) as { fixtureCommit: string };
    report.fixture = { revision: manifest.fixtureCommit, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token: canary });
  }
  if (task === 'S2.1') {
    const config = join(scratch, 'config.json');
    await writeFile(config, JSON.stringify({ version: 1, defaultProfile: 'test', profiles: { test: { origin, tokenOrigin: origin, token: { env: 'TEST_TOKEN' }, allowInsecureHttp: true } } }), { mode: 0o600 });
    const status = await invoke(['auth', 'status', '--config', config, '--profile', 'test'], 0, { GITEA_AXI_ORIGIN: 'https://wrong.test' });
    assert.deepEqual(status, { profile: 'test', origin, source: 'env:TEST_TOKEN', authenticated: true });
    assert.deepEqual((await invoke(['profile', 'list', '--config', config])).profiles, [{ name: 'test', default: true }]);
    assert.deepEqual(await invoke(['auth', 'status', '--config', config, '--profile', 'test', '--json']), await invoke(['auth', 'status', '--config', config, '--profile', 'test']));
    for (const args of [['--help'], ['repo', '--help'], ['repo', 'view', '--help'], ['capabilities', 'C075'], ['config', 'path', '--config', config], ['profile', 'list', '--config', config]]) {
      assert.deepEqual(await invoke([...args, '--json']), await invoke(args), 'JSON preserves structured output: ' + args.join(' '));
    }
    assert.equal((await invoke(['unknown', '--json'], 2)).error.code, 'USAGE');
    assert.equal((await invoke(['config', 'path', '--config', config])).path, config);
    assert.equal((await invoke(['doctor'])).identity.login, 'alice');
    const before = requests.length;
    for (const [extra, code] of [[{ GITEA_AXI_TOKEN_ORIGIN: '' }, 'CONFIG_INVALID'], [{ GITEA_AXI_TOKEN_ORIGIN: 'https://wrong.test' }, 'AUTH_BINDING_MISMATCH'], [{ GITEA_AXI_ALLOW_INSECURE_HTTP: 'false' }, 'CONFIG_INVALID'], [{ GITEA_AXI_TOKEN: JSON.stringify(canary) }, 'CONFIG_INVALID']] as const) assert.equal((await invoke(['auth', 'status'], 1, extra)).error.code, code);
    assert.equal(requests.length, before);
    assert.equal((await invoke(['auth', 'status'], 1, { GITEA_AXI_ORIGIN: undefined, GITEA_AXI_TOKEN_ORIGIN: undefined, GITEA_AXI_TOKEN: undefined, GITEA_AXI_ALLOW_INSECURE_HTTP: undefined })).error.code, 'AUTH_REQUIRED');
    const token = join(scratch, 'token'); await writeFile(token, '\uFEFF' + canary + '\n', { mode: 0o600 });
    assert.equal((await invoke(['repo', 'view', ...command], 0, { GITEA_AXI_TOKEN: JSON.stringify({ file: token }) })).repository.id, 10);
    await chmod(token, 0o644);
    assert.equal((await invoke(['auth', 'status'], 1, { GITEA_AXI_TOKEN: JSON.stringify({ file: token }) })).error.code, 'CONFIG_INSECURE');
    await chmod(token, 0o600); await symlink(token, token + '-link');
    assert.equal((await invoke(['auth', 'status'], 1, { GITEA_AXI_TOKEN: JSON.stringify({ file: token + '-link' }) })).error.code, 'CONFIG_INSECURE');
    mode = '403'; const denied = await invoke(['doctor'], 1); assert.equal(denied.error.code, 'PERMISSION_DENIED'); assert.match(denied.error.reason, /repository scope denied \[REDACTED\]/);
    assert.deepEqual(await invoke(['doctor', '--json'], 1), denied);
    for (const path of ['user', 'orgs/sample', 'repos/sample/demo', 'repos/sample/demo/issues']) {
      const failure = await invoke(['api', path], 1); assert.equal(failure.error.code, 'PERMISSION_DENIED'); assert.match(failure.error.reason, /repository scope denied \[REDACTED\]/);
    }
    const writer = join(prefix, 'node_modules/@knowttl/gitea-axi/dist/private-file.js');
    await run(process.execPath, ['--input-type=module', '-e', `const {writePrivateFile}=await import(${JSON.stringify(writer)}); await writePrivateFile(${JSON.stringify(config)}, 'prior valid configuration');`]);
    const monitor = watch(scratch);
    const interrupted = spawn(process.execPath, ['--input-type=module', '-e', `const {writePrivateFile}=await import(${JSON.stringify(writer)}); await writePrivateFile(${JSON.stringify(config)}, 'x'.repeat(64000000));`], { stdio: 'ignore', timeout: 10000 });
    monitor.on('change', (_event, name) => { if ((name as string | null)?.endsWith('.tmp')) interrupted.kill('SIGKILL'); });
    const [, signal] = await once(interrupted, 'close'); monitor.close();
    assert.equal(signal, 'SIGKILL'); assert.equal(await readFile(config, 'utf8'), 'prior valid configuration');
  } else if (task === 'S2.2') {
    assert.equal((await invoke(['repo', 'view', ...command])).repository.full_name, 'sample/demo');
    assert.deepEqual((await invoke(['repo', 'list'])).items, [{ id: 10, full_name: 'sample/demo', default_branch: 'main' }]);
    assert.equal((await invoke(['repo', 'list', '--org', 'sample'])).items[0]!.id, 10);
    assert.equal((await invoke(['org', 'view', 'sample'])).organization.name, 'sample');
    await run('git', ['init', join(scratch, 'workspace')]);
    await run('git', ['-C', join(scratch, 'workspace'), 'remote', 'add', 'origin', origin + '/sample/demo.git']);
    assert.equal((decode(await run(process.execPath, [bin, 'repo', 'view'], { cwd: join(scratch, 'workspace'), env })) as unknown as Output).repository.id, 10);
    await run('git', ['-C', join(scratch, 'workspace'), 'remote', 'set-url', 'origin', 'https://wrong.test/other/repo.git']);
    assert.equal((decode(await run(process.execPath, [bin, 'repo', 'view'], { cwd: join(scratch, 'workspace'), env, code: 2 })) as unknown as Output).error.code, 'USAGE');
    assert.equal((decode(await run(process.execPath, [bin, 'repo', 'view', ...command], { cwd: join(scratch, 'workspace'), env })) as unknown as Output).repository.id, 10);
    mode = 'empty';
    for (const family of ['issue', 'pr', 'label', 'release', 'run']) {
      const result = await invoke([family, 'list', ...command]); assert.deepEqual(result.items, []); assert.equal(result.total, family === 'release' ? null : 0); assert.equal(result.continuation, false);
    }
    const dashboard = await invoke(['--repo', 'sample/demo']); assert.equal(dashboard.partial, false); assert.deepEqual(dashboard.sections.runs.items, []);
    assert.deepEqual(await invoke(['-R', 'sample/demo']), dashboard);
    for (const selectors of [['-R', 'sample/demo', '--repo', 'sample/demo'], ['--repo', 'sample/demo', '-R', 'sample/demo'], ['-R', 'sample/demo', '-R', 'sample/demo']]) {
      const before = requests.length;
      assert.equal((await invoke(selectors, 2, {}, false)).error.code, 'USAGE');
      assert.equal(requests.length, before, 'Duplicate root repository selectors dispatch no requests');
    }
    mode = 'permission-section'; const partial = await invoke(['--repo', 'sample/demo']); assert.equal(partial.partial, true); assert.equal(partial.sections.labels.code, 'PERMISSION_DENIED'); assert.equal(partial.sections.labels.items, undefined);
    const count = requests.length; await invoke(['--help'], 0, { GITEA_AXI_TOKEN: 'invalid' }); assert.equal(requests.length, count);
    for (const flag of ['--version', '-v', '-V']) assert.equal(await run(process.execPath, [bin, flag], { env }), version + '\n');
    for (const flag of ['--version', '-v', '-V']) {
      assert.equal(await run(process.execPath, [bin, flag, '--json'], { env }), version + '\n');
      assert.equal(await run(process.execPath, [bin, '--json', flag], { env }), version + '\n');
    }
  } else if (task === 'S2.3') {
    for (const [limit, ids] of [['1', [3]], ['2', [3, 1]]] as const) {
      const result = await invoke(['issue', 'list', ...command, '--state', 'open', '--limit', limit]);
      assert.deepEqual(result.items.map(item => item.number), ids); assert.equal(result.continuation, limit === '1'); assert.equal(result.total, 2);
    }
    for (const family of ['issue', 'pr']) {
      const result = await invoke([family, 'list', ...command, '--author', 'alice', '--assignee', 'alice', '--label', 'bug', '--milestone', '123']);
      assert.deepEqual(result.items.map(item => item.number), family === 'pr' ? [7] : [1]);
      assert.equal((await invoke([family, 'list', ...command, '--milestone', '999'], 2)).error.code, 'USAGE');
    }
    assert.equal((await invoke(['issue', 'view', '1', ...command, '--comments'])).comments[0]!.body, 'Please verify');
    const review = { id: 12, author: { login: 'alice', name: 'Alice' }, state: 'APPROVED', dismissed: false, stale: false, body: 'Looks good', commit: { oid: 'abc123' }, submittedAt: '2026-02-04T00:00:00Z', comments: [{ id: 13, body: 'Nice', path: 'app.ts', position: 2, commit: { oid: 'abc123' } }] };
    const rollup = { head: 'abc123', items: [{ name: 'test', state: 'pending', description: null, url: null }, { name: 'lint', state: 'failure', description: null, url: null }, { name: 'build', state: 'success', description: 'Built', url: 'https://example.test/build' }], passed: 1, failed: 1, pending: 1, exitCode: 1 };
    Object.assign(rollup, { source: 'commit-statuses', partial: true });
    const expected = { ...fixture.expectedFields, reviews: [review], latestReviews: [review], statusCheckRollup: rollup };
    assert.equal(Object.keys(expected).length + fixture.gaps.length, 46);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(await invoke(['pr', 'view', '7', ...command, '--fields', field]), { [field]: value }, field);
    for (const gap of fixture.gaps) assert.equal((await invoke(['pr', 'view', '7', ...command, '--fields', gap], 1)).error.code, 'CAPABILITY_GAP');
    const detail = await invoke(['pr', 'view', '7', ...command, '--reviews', '--checks']); assert.deepEqual(detail.reviews, [review]); assert.deepEqual(detail.statusCheckRollup, rollup);
    mode = 'team-reviewers';
    assert.deepEqual((await invoke(['pr', 'view', '7', ...command, '--fields', 'reviewRequests'], 0, {}, false)).reviewRequests, [{ type: 'team', id: 22, name: 'maintainers' }]);
    mode = 'mixed-reviewers';
    assert.deepEqual((await invoke(['pr', 'view', '7', ...command, '--fields', 'reviewRequests'], 0, {}, false)).reviewRequests, [...fixture.expectedFields.reviewRequests, { type: 'team', id: 22, name: 'maintainers' }]);
    mode = 'ok';
    // #6: the vendor returns all inline comments without pagination.
    mode = 'many-inline';
    const selectedReviews = await invoke(['pr', 'view', '7', ...command, '--fields', 'reviews,latestReviews']);
    assert.deepEqual(selectedReviews.reviews[0]!.comments.map(row => row.body), Array.from({ length: 50 }, (_, index) => 'Line ' + index));
    assert.deepEqual(selectedReviews.latestReviews, selectedReviews.reviews);
    assert.equal((await invoke(['pr', 'view', '7', ...command, '--reviews'])).reviews[0]!.comments.length, 50);
    mode = 'inline-over-limit';
    assert.equal((await invoke(['pr', 'view', '7', ...command, '--fields', 'reviews'], 1)).error.code, 'RESPONSE_LIMIT');
    mode = 'inline-hostile';
    assert.equal((await invoke(['pr', 'view', '7', ...command, '--fields', 'reviews'], 1)).error.code, 'UNSAFE_PAGINATION');
    assert.equal(foreignRequests, 0);
    mode = 'ok';
    for (const [state, code, counts] of [['ok', 1, [1, 1, 1]], ['passed', 0, [1, 0, 0]], ['pending', 8, [0, 0, 1]], ['absent', 1, [0, 0, 0]]] as const) {
      mode = state; const result = await invoke(['pr', 'checks', '7', ...command], code); assert.deepEqual([result.passed, result.failed, result.pending], counts);
    }
    mode = 'pending'; const deadline = await invoke(['pr', 'checks', '7', ...command, '--watch', '--timeout', '1', '--interval', '1'], 8); assert.equal(deadline.pending, 1);
    assert.equal((await invoke(['pr', 'checks', '7', ...command, '--json'], 8)).pending, 1);
    const cancelled = (decode(await run(process.execPath, [bin, 'pr', 'checks', '7', ...command, '--watch', '--timeout', '10'], { env, code: 8, cancel: true })) as unknown as Output); assert.equal(cancelled.cancelled, true);
    mode = 'held-watch';
    for (const [path, page, body] of [[base + '/pulls/7', '1', false], [base + '/commits/abc123/status', '1', false], [base + '/commits/abc123/statuses', '1', false], [base + '/commits/abc123/statuses', '2', false], [base + '/commits/abc123/status', '1', true], [base + '/commits/abc123/statuses', '2', true]] as const) {
      holdPath = path; holdPage = page; holdBody = body;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        watchPullReads = 0;
        const result = (decode(await run(process.execPath, [bin, 'pr', 'checks', '7', ...command, '--watch', '--timeout', '30'], { env, code: 8, cancel: true, cancelEvent: 'watch-held', signal, timeout: 5000 })) as unknown as Output);
        assert.equal(result.cancelled, true, signal + ' cancels stalled ' + path + ' page ' + page);
        assert.equal(result.exitCode, 8); assert.deepEqual(result.items, []);
        assert.equal(heldClosed, true, 'Cancellation closes the held HTTP request');
      }
    }
    holdAfterPolls = 2; holdPath = base + '/commits/abc123/status'; holdPage = '1'; holdBody = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      watchPullReads = 0;
      const result = (decode(await run(process.execPath, [bin, 'pr', 'checks', '7', ...command, '--watch', '--timeout', '30', '--interval', '1'], { env, code: 8, cancel: true, cancelEvent: 'watch-held', signal, timeout: 5000 })) as unknown as Output);
      assert.deepEqual([result.cancelled, result.exitCode, result.pending, result.head], [true, 8, 1, 'abc123']);
      assert.equal(heldClosed, true);
    }
    mode = 'pending';
    const diff = await invoke(['pr', 'diff', '7', ...command]); assert.equal(diff.truncated, true); assert.equal(diff.diff.length, 10000);
    assert.equal((await invoke(['pr', 'diff', '7', ...command, '--full'])).truncated, false);
    const originalDiff = diffText;
    for (const content of ['x'.repeat(120000), '"\n\\'.repeat(50000)]) {
      diffText = 'diff --git a/app.ts b/app.ts\n+' + content;
      const large = await invoke(['pr', 'diff', '7', ...command, '--full']);
      assert(renderedChars <= 100000, 'Serialized full diff fits the output ceiling');
      assert.equal(large.chars, diffText.length);
      assert.equal(large.truncated, true);
      assert(large.diff.length > 1000, 'Oversized diff retains useful patch text');
      assert(diffText.startsWith(large.diff), 'Bounded diff is an unchanged source prefix');
      const jsonDiff = await invoke(['pr', 'diff', '7', ...command, '--full', '--json']);
      assert(renderedChars <= 100000); assert.equal(jsonDiff.chars, diffText.length); assert.equal(jsonDiff.truncated, true); assert(jsonDiff.diff.length > 1000); assert(diffText.startsWith(jsonDiff.diff));
    }
    diffText = originalDiff;
    for (const flags of [['--fields', 'unknown'], ['--fields', 'title', '--reviews']]) assert.equal((await invoke(['pr', 'view', '7', ...command, ...flags], 2)).error.code, 'USAGE');
  } else {
    assert.equal((await invoke(['api', 'GET', 'version'])).data.version, '1.23.4');
    assert.equal((await invoke(['api', '/swagger.v1.json'])).data.info.version, '1.23.4');
    assert.equal((await invoke(['api', 'repos/sample/demo'])).data.id, 10);
    // #11: documented nullable contents fields retain their non-null type checks.
    assert.deepEqual((await invoke(['api', 'GET', base + '/contents/README.md'])).data, contentsFile);
    assert.deepEqual((await invoke(['api', 'GET', base + '/contents/link'])).data, contentsLink);
    assert.deepEqual((await invoke(['api', 'GET', base + '/contents/module'])).data, contentsSubmodule);
    // #48/#11: root and entry-directory arrays preserve every documented entry.
    for (const [path, entries] of [[base + '/contents', contentsRoot], [base + '/contents/src', contentsDirectory]] as const) {
      assert.deepEqual((await invoke(['api', 'GET', path])).data, entries);
    }
    mode = 'empty-contents';
    assert.deepEqual((await invoke(['api', 'GET', base + '/contents/src'])).data, []);
    mode = 'invalid-contents';
    for (const path of ['/contents/README.md', '/contents', '/contents/src']) assert.equal((await invoke(['api', 'GET', base + path], 1)).error.code, 'INVALID_RESPONSE');
    for (const invalid of ['invalid-contents-link', 'invalid-download-url']) {
      mode = invalid;
      assert.equal((await invoke(['api', 'GET', base + '/contents/module'], 1)).error.code, 'INVALID_RESPONSE');
    }
    mode = 'ok';
    // #12: only documented filepath and full Git-ref reads accept multiple segments.
    for (const [path, expected] of [
      ['/contents/src/main.ts', nestedContentsFile], ['/contents/src/nested', []],
      ['/editorconfig/src/main.ts', editorConfig], ['/git/refs/heads/main', gitReferences],
    ]) assert.deepEqual((await invoke(['api', 'GET', base + path])).data, expected);
    const beforePathRefusals = requests.length;
    for (const [path, exitCode, code] of [
      [base + '/contents/src/../README.md', 2, 'USAGE'], [base + '/contents/src/%2e%2e/README.md', 2, 'USAGE'],
      [base + '/contents/src/%252e%252e/README.md', 2, 'USAGE'], [base + '/contents/src%2Fmain.ts', 1, 'READ_ONLY'],
      [base + '/branches/feature/topic', 1, 'READ_ONLY'], [base + '/commits/feature/topic/status', 1, 'READ_ONLY'],
      ['/api/v1/repos/sample/extra/demo/contents/README.md', 1, 'READ_ONLY'],
    ] as const) assert.equal((await invoke(['api', 'GET', path], exitCode, {}, false)).error.code, code);
    assert.equal((await invoke(['api', 'POST', base + '/contents/src/main.ts', '--field', 'content=eA==', '--preview', '--allow-write', 'repoCreateFile'], 1, {}, false)).error.code, 'READ_ONLY');
    assert.equal(requests.length, beforePathRefusals);
    const before = requests.length;
    for (const path of ['user/applications/oauth2/1', 'repos/o/r/hooks/1']) {
      const refusal = await invoke(['api', path], 1);
      assert.equal(refusal.error.code, 'READ_ONLY');
      assert.match(refusal.error.reason, /Credential-bearing API routes are refused/);
    }
    for (const path of ['admin/emails', 'admin/emails/search', 'admin/users']) {
      const refusal = await invoke(['api', path], 1);
      assert.equal(refusal.error.code, 'READ_ONLY');
      assert.match(refusal.error.reason, /Administrative API routes are refused/);
    }
    for (const path of ['repos/o/r/git/commits/abc123.diff', 'repos/o/r/pulls/7.diff', 'repos/o/r/pulls/7.patch', 'repos/o/r/media/file.txt', 'repos/o/r/raw/file.txt', 'repos/o/r/archive/main.zip', 'repos/o/r/archive/main.tar.gz']) {
      const refusal = await invoke(['api', path], 1);
      assert.equal(refusal.error.code, 'READ_ONLY');
      assert.match(refusal.error.reason, /only JSON metadata reads are available/);
    }
    // Unsafe and unclassified paths are refused by hosted admission before CLI execution.
    for (const [path, exitCode, errorCode, admissionCode] of [
      ['https://foreign.test/api/v1/user', 2, 'USAGE', 'INVALID_INPUT'], ['../user', 2, 'USAGE', 'INVALID_INPUT'],
      ['%2e%2e/user', 2, 'USAGE', 'INVALID_INPUT'], ['user?token=canary', 2, 'USAGE', 'FLAG_BLOCKED'],
      ['repos/sample/demo/actions/runners/registration-token', 1, 'READ_ONLY', 'INVALID_INPUT'],
      ['unknown', 1, 'READ_ONLY', 'INVALID_INPUT'],
    ] as const) {
      assert.equal((await invoke(['api', path], exitCode, {}, false)).error.code, errorCode);
      if (host) report.hostedRefusals.push({ args: ['api', path], response: await host.refuse(['api', path], admissionCode) });
    }
    assert.equal(requests.length, before);
    for (const [failure, code] of [['missing', 'INVALID_RESPONSE'], ['wrong-type', 'INVALID_RESPONSE'], ['malformed', 'INVALID_RESPONSE'], ['html', 'INVALID_RESPONSE'], ['401', 'AUTH_REQUIRED'], ['403', 'PERMISSION_DENIED'], ['404', 'NOT_FOUND_OR_HIDDEN'], ['429', 'RATE_LIMITED'], ['redirect', 'TRANSPORT_ERROR']] as const) {
      mode = failure; assert.equal((await invoke(['api', 'repos/sample/demo'], 1)).error.code, code);
    }
    mode = 'secret'; assert.equal((await invoke(['api', 'version'])).data.version, '[REDACTED]|[REDACTED]'); assert.equal((await invoke(['api', 'version'])).data.access_token, '[REDACTED]');
    mode = 'hostile'; assert.equal((await invoke(['issue', 'list', ...command], 1)).error.code, 'UNSAFE_PAGINATION'); assert.equal(foreignRequests, 0);
    mode = 'envelope'; assert.equal((await invoke(['run', 'list', ...command], 1)).error.code, 'INVALID_RESPONSE');
  }
  report.result = 'passed';
  console.log(task + ' passed: installed package, offline fake, ' + requests.length + ' authenticated requests; Artium: ' + (host ? 'verified' : 'skipped: Artium fixture not supplied'));
} finally {
  if (host) await host.close();
  for (const service of [server, foreign]) { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
  report.authenticatedRequests = requests.length;
  const reportPath = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('report: ' + reportPath);
  await rm(scratch, { recursive: true, force: true });
}
