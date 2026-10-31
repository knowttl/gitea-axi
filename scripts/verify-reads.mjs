import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3];
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/S2/reads.json', import.meta.url), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'gitea-axi-' + task + '-'));
const canary = 'CANARY-S2-"/%-token';
const base = '/api/v1/repos/sample/demo';
const command = ['--repo', 'sample/demo'];
const requests = [];
let mode = 'ok';
let bin;
let origin;
let foreignRequests = 0;
let host;
const report = { task, channel: 'offline-fake', result: 'failed', hostedInvocations: 0, hostedRefusals: [], fixture: null };
const foreign = createServer((_request, response) => { foreignRequests++; response.end('{}'); });
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  assert.equal(request.headers.authorization, 'token ' + canary);
  const url = new URL(request.url, origin);
  if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1:' + foreign.address().port }).end(); return; }
  if (mode === 'html') { response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>failure</h1>'); return; }
  if (/^(401|403|404|429)$/.test(mode)) {
    response.writeHead(Number(mode), { 'content-type': 'application/json', 'retry-after': '999' }).end(JSON.stringify({ message: 'repository scope denied ' + canary })); return;
  }
  if (mode === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }).end('{broken'); return; }
  const paths = {
    '/api/v1/version': { version: '1.23.4' }, '/swagger.v1.json': { info: { version: '1.23.4' }, paths: { '/version': {} } },
    '/api/v1/user': fixture.user, '/api/v1/orgs/sample': { id: 2, name: 'sample' },
    '/api/v1/repos/search': { ok: true, data: [fixture.repository] }, '/api/v1/orgs/sample/repos': [fixture.repository],
    [base]: fixture.repository, [base + '/issues/1']: fixture.issues[0], [base + '/pulls/7']: fixture.pull,
    [base + '/labels']: [fixture.label], [base + '/milestones']: [fixture.milestone],
    [base + '/releases']: [], [base + '/actions/tasks']: { workflow_runs: [], total_count: 0 },
    [base + '/pulls']: [fixture.pull], [base + '/issues/7/comments']: fixture.comments, [base + '/issues/1/comments']: fixture.comments,
    [base + '/pulls/7/reviews']: fixture.reviews, [base + '/pulls/7/reviews/12/comments']: fixture.inline,
    [base + '/pulls/7/commits']: fixture.commits, [base + '/pulls/7/files']: fixture.files, [base + '/issues/7/reactions']: fixture.reactions,
    [base + '/commits/abc123/status']: { sha: 'abc123', statuses: fixture.statuses, total_count: 3 },
    [base + '/commits/abc123/statuses']: mode === 'pending' ? [fixture.statuses[2]] : mode === 'passed' ? [fixture.statuses[0]] : mode === 'absent' ? [] : fixture.statuses,
  };
  let body = paths[url.pathname];
  if (url.pathname === base + '/issues') {
    const page = url.searchParams.get('page');
    body = page === '1' ? [fixture.issues[1]] : page === '2' ? [fixture.issues[0]] : [fixture.issues[2], fixture.issues[0]];
    if (page !== '3') response.setHeader('link', `<${origin}${base}/issues?state=all&type=issues&limit=1&page=${Number(page) + 1}>; rel="next"`);
  }
  if (mode === 'empty') {
    if (url.pathname.endsWith('/issues') || url.pathname.endsWith('/pulls') || url.pathname.endsWith('/labels')) { body = []; response.removeHeader('link'); response.setHeader('x-total-count', '0'); }
  }
  if (mode === 'permission-section' && url.pathname.endsWith('/labels')) { response.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"issue scope required"}'); return; }
  if (mode === 'hostile' && url.pathname.endsWith('/issues')) response.setHeader('link', `<http://127.0.0.1:${foreign.address().port}${base}/issues?page=2>; rel="next"`);
  if (mode === 'missing' && url.pathname === base) body = { id: 10, full_name: 'sample/demo' };
  if (mode === 'wrong-type' && url.pathname === base) body = { ...fixture.repository, id: 'ten' };
  if (mode === 'secret' && url.pathname === '/api/v1/version') body = { version: canary + '|' + encodeURIComponent(canary), access_token: 'other-secret' };
  if (mode === 'envelope' && url.pathname.endsWith('/actions/tasks')) body = [];
  if (url.pathname === base + '/pulls/7.diff') { response.writeHead(200, { 'content-type': 'text/plain' }).end('diff --git a/app.ts b/app.ts\n+' + 'x'.repeat(11000)); return; }
  if (body === undefined) { response.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"unknown fake route"}'); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname.endsWith('/statuses')) server.emit('check-read');
});
async function run(executable, argv, options = {}) {
  const child = spawn(executable, argv, { cwd: options.cwd ?? scratch, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  if (options.cancel) server.once('check-read', () => child.kill('SIGINT'));
  const [code] = await once(child, 'close');
  assert.equal(code, options.code ?? 0, argv.join(' ') + '\n' + stdout + stderr);
  return stdout;
}
let env;
const invoke = async (argv, code = 0, extra = {}, hosted = true) => {
  const output = await run(process.execPath, [bin, ...argv], { code, env: { ...env, ...extra } });
  for (const form of [canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary)]) assert(!output.includes(form), 'Canary escaped output');
  const result = decode(output);
  if (host && hosted && ['repo', 'issue', 'pr', 'label', 'release', 'run', 'api', 'org', '--repo'].includes(argv[0]) && Object.keys(extra).length === 0) {
    const hosted = await host.invoke(argv[0] === '--repo' ? ['dashboard', ...argv] : argv, code);
    report.hostedInvocations++;
    assert.deepEqual(hosted, result, 'Hosted and standalone read agree: ' + argv.join(' '));
  }
  return result;
};
try {
  await run('npm', ['run', 'build'], { cwd: root });
  const [packed] = JSON.parse(await run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root }));
  report.packageSha256 = createHash('sha256').update(await readFile(join(scratch, packed.filename))).digest('hex');
  report.sourceHead = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
  report.sourceDirty = Boolean((await run('git', ['-C', root, 'status', '--porcelain'])).trim());
  const prefix = join(scratch, 'installed');
  await run('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename)]);
  bin = join(prefix, 'node_modules/@knowttl/gitea-axi/dist/cli.js');
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  env = { PATH: process.env.PATH, HOME: scratch, APPDATA: scratch, XDG_CONFIG_HOME: scratch, GITEA_AXI_ORIGIN: origin,
    GITEA_AXI_TOKEN_ORIGIN: origin, GITEA_AXI_TOKEN: JSON.stringify({ env: 'TEST_TOKEN' }), TEST_TOKEN: canary, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true' };
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST, 'Hosted proof requires GITEA_AXI_ARTIUM_MANIFEST from the frozen fixture');
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(bytes.toString('utf8'));
    report.fixture = { revision: manifest.fixtureCommit, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token: canary });
  }
  if (task === 'S2.1') {
    const config = join(scratch, 'config.json');
    await writeFile(config, JSON.stringify({ version: 1, defaultProfile: 'test', profiles: { test: { origin, tokenOrigin: origin, token: { env: 'TEST_TOKEN' }, allowInsecureHttp: true } } }), { mode: 0o600 });
    const status = await invoke(['auth', 'status', '--config', config, '--profile', 'test'], 0, { GITEA_AXI_ORIGIN: 'https://wrong.test' });
    assert.deepEqual(status, { profile: 'test', origin, source: 'env:TEST_TOKEN', authenticated: true });
    assert.deepEqual((await invoke(['profile', 'list', '--config', config])).profiles, [{ name: 'test', default: true }]);
    assert.equal((await invoke(['config', 'path', '--config', config])).path, config);
    assert.equal((await invoke(['doctor'])).identity.login, 'alice');
    const before = requests.length;
    for (const [extra, code] of [[{ GITEA_AXI_TOKEN_ORIGIN: '' }, 'CONFIG_INVALID'], [{ GITEA_AXI_TOKEN_ORIGIN: 'https://wrong.test' }, 'AUTH_BINDING_MISMATCH'], [{ GITEA_AXI_ALLOW_INSECURE_HTTP: 'false' }, 'CONFIG_INVALID'], [{ GITEA_AXI_TOKEN: JSON.stringify(canary) }, 'CONFIG_INVALID']]) assert.equal((await invoke(['auth', 'status'], 1, extra)).error.code, code);
    assert.equal(requests.length, before);
    assert.equal((await invoke(['auth', 'status'], 1, { GITEA_AXI_ORIGIN: undefined, GITEA_AXI_TOKEN_ORIGIN: undefined, GITEA_AXI_TOKEN: undefined, GITEA_AXI_ALLOW_INSECURE_HTTP: undefined })).error.code, 'AUTH_REQUIRED');
    const token = join(scratch, 'token'); await writeFile(token, '\uFEFF' + canary + '\n', { mode: 0o600 });
    assert.equal((await invoke(['repo', 'view', ...command], 0, { GITEA_AXI_TOKEN: JSON.stringify({ file: token }) })).repository.id, 10);
    await chmod(token, 0o644);
    assert.equal((await invoke(['auth', 'status'], 1, { GITEA_AXI_TOKEN: JSON.stringify({ file: token }) })).error.code, 'CONFIG_INSECURE');
    await chmod(token, 0o600); await symlink(token, token + '-link');
    assert.equal((await invoke(['auth', 'status'], 1, { GITEA_AXI_TOKEN: JSON.stringify({ file: token + '-link' }) })).error.code, 'CONFIG_INSECURE');
    mode = '403'; const denied = await invoke(['doctor'], 1); assert.equal(denied.error.code, 'PERMISSION_DENIED'); assert.match(denied.error.reason, /repository scope denied \[REDACTED\]/);
    for (const path of ['user', 'orgs/sample', 'repos/sample/demo', 'repos/sample/demo/issues']) {
      const failure = await invoke(['api', path], 1); assert.equal(failure.error.code, 'PERMISSION_DENIED'); assert.match(failure.error.reason, /repository scope denied \[REDACTED\]/);
    }
    const writer = join(prefix, 'node_modules/@knowttl/gitea-axi/dist/private-file.js');
    await run(process.execPath, ['--input-type=module', '-e', `const {writePrivateFile}=await import(${JSON.stringify(writer)}); await writePrivateFile(${JSON.stringify(config)}, 'prior valid configuration');`]);
    const monitor = watch(scratch);
    const interrupted = spawn(process.execPath, ['--input-type=module', '-e', `const {writePrivateFile}=await import(${JSON.stringify(writer)}); await writePrivateFile(${JSON.stringify(config)}, 'x'.repeat(64000000));`], { stdio: 'ignore', timeout: 10000 });
    monitor.on('change', (_event, name) => { if (name?.endsWith('.tmp')) interrupted.kill('SIGKILL'); });
    const [, signal] = await once(interrupted, 'close'); monitor.close();
    assert.equal(signal, 'SIGKILL'); assert.equal(await readFile(config, 'utf8'), 'prior valid configuration');
  } else if (task === 'S2.2') {
    assert.equal((await invoke(['repo', 'view', ...command])).repository.full_name, 'sample/demo');
    assert.deepEqual((await invoke(['repo', 'list'])).items, [{ id: 10, full_name: 'sample/demo', default_branch: 'main' }]);
    assert.equal((await invoke(['repo', 'list', '--org', 'sample'])).items[0].id, 10);
    assert.equal((await invoke(['org', 'view', 'sample'])).organization.name, 'sample');
    await run('git', ['init', join(scratch, 'workspace')]);
    await run('git', ['-C', join(scratch, 'workspace'), 'remote', 'add', 'origin', origin + '/sample/demo.git']);
    assert.equal(decode(await run(process.execPath, [bin, 'repo', 'view'], { cwd: join(scratch, 'workspace'), env })).repository.id, 10);
    await run('git', ['-C', join(scratch, 'workspace'), 'remote', 'set-url', 'origin', 'https://wrong.test/other/repo.git']);
    assert.equal(decode(await run(process.execPath, [bin, 'repo', 'view'], { cwd: join(scratch, 'workspace'), env, code: 2 })).error.code, 'USAGE');
    assert.equal(decode(await run(process.execPath, [bin, 'repo', 'view', ...command], { cwd: join(scratch, 'workspace'), env })).repository.id, 10);
    mode = 'empty';
    for (const family of ['issue', 'pr', 'label', 'release', 'run']) {
      const result = await invoke([family, 'list', ...command]); assert.deepEqual(result.items, []); assert.equal(result.total, family === 'release' ? null : 0); assert.equal(result.continuation, false);
    }
    const dashboard = await invoke(['--repo', 'sample/demo']); assert.equal(dashboard.partial, false); assert.deepEqual(dashboard.sections.runs.items, []);
    mode = 'permission-section'; const partial = await invoke(['--repo', 'sample/demo']); assert.equal(partial.partial, true); assert.equal(partial.sections.labels.code, 'PERMISSION_DENIED'); assert.equal(partial.sections.labels.items, undefined);
    const count = requests.length; await invoke(['--help'], 0, { GITEA_AXI_TOKEN: 'invalid' }); assert.equal(requests.length, count);
    for (const flag of ['--version', '-v', '-V']) assert.equal(await run(process.execPath, [bin, flag], { env }), '0.1.0\n');
  } else if (task === 'S2.3') {
    for (const [limit, ids] of [['1', [3]], ['2', [3, 1]]]) {
      const result = await invoke(['issue', 'list', ...command, '--state', 'open', '--limit', limit]);
      assert.deepEqual(result.items.map(item => item.number), ids); assert.equal(result.continuation, limit === '1'); assert.equal(result.total, 2);
    }
    for (const family of ['issue', 'pr']) {
      const result = await invoke([family, 'list', ...command, '--author', 'alice', '--assignee', 'alice', '--label', 'bug', '--milestone', '123']);
      assert.deepEqual(result.items.map(item => item.number), family === 'pr' ? [7] : [1]);
      assert.equal((await invoke([family, 'list', ...command, '--milestone', '999'], 2)).error.code, 'USAGE');
    }
    assert.equal((await invoke(['issue', 'view', '1', ...command, '--comments'])).comments[0].body, 'Please verify');
    const review = { id: 12, author: { login: 'alice', name: 'Alice' }, state: 'APPROVED', dismissed: false, stale: false, body: 'Looks good', commit: { oid: 'abc123' }, submittedAt: '2026-02-04T00:00:00Z', comments: [{ id: 13, body: 'Nice', path: 'app.ts', position: 2, commit: { oid: 'abc123' } }] };
    const rollup = { head: 'abc123', items: [{ name: 'test', state: 'pending', description: null, url: null }, { name: 'lint', state: 'failure', description: null, url: null }, { name: 'build', state: 'success', description: 'Built', url: 'https://example.test/build' }], passed: 1, failed: 1, pending: 1, exitCode: 1 };
    const expected = { ...fixture.expectedFields, reviews: [review], latestReviews: [review], statusCheckRollup: rollup };
    assert.equal(Object.keys(expected).length + fixture.gaps.length, 46);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(await invoke(['pr', 'view', '7', ...command, '--fields', field]), { [field]: value }, field);
    for (const gap of fixture.gaps) assert.equal((await invoke(['pr', 'view', '7', ...command, '--fields', gap], 1)).error.code, 'CAPABILITY_GAP');
    const detail = await invoke(['pr', 'view', '7', ...command, '--reviews', '--checks']); assert.deepEqual(detail.reviews, [review]); assert.deepEqual(detail.statusCheckRollup, rollup);
    for (const [state, code, counts] of [['ok', 1, [1, 1, 1]], ['passed', 0, [1, 0, 0]], ['pending', 8, [0, 0, 1]], ['absent', 1, [0, 0, 0]]]) {
      mode = state; const result = await invoke(['pr', 'checks', '7', ...command], code); assert.deepEqual([result.passed, result.failed, result.pending], counts);
    }
    mode = 'pending'; const deadline = await invoke(['pr', 'checks', '7', ...command, '--watch', '--timeout', '1', '--interval', '1'], 8); assert.equal(deadline.pending, 1);
    const cancelled = decode(await run(process.execPath, [bin, 'pr', 'checks', '7', ...command, '--watch', '--timeout', '10'], { env, code: 8, cancel: true })); assert.equal(cancelled.cancelled, true); assert.equal(cancelled.pending, 1);
    const diff = await invoke(['pr', 'diff', '7', ...command]); assert.equal(diff.truncated, true); assert.equal(diff.diff.length, 10000);
    assert.equal((await invoke(['pr', 'diff', '7', ...command, '--full'])).truncated, false);
    for (const flags of [['--fields', 'unknown'], ['--fields', 'title', '--reviews']]) assert.equal((await invoke(['pr', 'view', '7', ...command, ...flags], 2)).error.code, 'USAGE');
  } else {
    assert.equal((await invoke(['api', 'GET', 'version'])).data.version, '1.23.4');
    assert.equal((await invoke(['api', '/swagger.v1.json'])).data.info.version, '1.23.4');
    assert.equal((await invoke(['api', 'repos/sample/demo'])).data.id, 10);
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
      ['%2e%2e/user', 2, 'USAGE', 'INVALID_INPUT'], ['user?token=canary', 1, 'CONFIG_INVALID', 'FLAG_BLOCKED'],
      ['repos/sample/demo/actions/runners/registration-token', 1, 'READ_ONLY', 'INVALID_INPUT'],
      ['unknown', 1, 'READ_ONLY', 'INVALID_INPUT'],
    ]) {
      assert.equal((await invoke(['api', path], exitCode, {}, false)).error.code, errorCode);
      if (host) report.hostedRefusals.push({ args: ['api', path], response: await host.refuse(['api', path], admissionCode) });
    }
    assert.equal(requests.length, before);
    for (const [failure, code] of [['missing', 'INVALID_RESPONSE'], ['wrong-type', 'INVALID_RESPONSE'], ['malformed', 'INVALID_RESPONSE'], ['html', 'INVALID_RESPONSE'], ['401', 'AUTH_REQUIRED'], ['403', 'PERMISSION_DENIED'], ['404', 'NOT_FOUND_OR_HIDDEN'], ['429', 'RATE_LIMITED'], ['redirect', 'TRANSPORT_ERROR']]) {
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
  for (const service of [server, foreign]) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
  report.authenticatedRequests = requests.length;
  const reportPath = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('report: ' + reportPath);
  await rm(scratch, { recursive: true, force: true });
}
