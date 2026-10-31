import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3]!;
assert(['S5.1', 'S5.2'].includes(task));
const scratch = await mkdtemp(join(tmpdir(), 'gitea-s5-'));
const invocations: { argv: string[]; code: number | null }[] = [];
const canary = 'CANARY-S5-not-a-real-token';
let mode = 'ok';
let origin = '';
const base = '/api/v1/repos/sample/demo';
// Synthetic payloads follow retained 1.23.4 ActionTask, Issue, Repository and Commit schemas.
const user = { id: 3, login: 'alice' };
const repository = { id: 4, full_name: 'sample/demo', default_branch: 'main', description: 'login tool', language: 'Go', stars_count: 60 };
const issue = { id: 11, number: 11, title: 'login bug', state: 'open', user, assignees: [user], labels: [{ id: 8, name: 'bug', color: 'ff0000' }], repository, created_at: '2026-01-01T00:00:00Z' };
const rows = [
  { id: 9, name: 'other', status: 'running', workflow_id: 'other.yml', head_branch: 'dev', head_sha: 'bad', event: 'push' },
  { id: 12, name: 'ci', status: 'success', workflow_id: 'ci.yml', head_branch: 'main', head_sha: 'abc', event: 'push' },
];
const requests: string[] = [];
let host: Awaited<ReturnType<typeof readHost>> | undefined;
const server = createServer((request, response) => {
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.authorization, 'token ' + canary);
  const url = new URL(request.url!, origin);
  requests.push(url.pathname);
  if (mode === 'denied') { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'scope denied ' + canary })); return; }
  const second = url.searchParams.get('page') === '2';
  let data: unknown;
  if (url.pathname.endsWith('/actions/tasks')) data = mode === 'invalid' ? { workflow_runs: [{ name: 'missing identity' }], total_count: 1 } : { workflow_runs: [rows[second ? 1 : 0]], total_count: 2 };
  else if (url.pathname === base) data = repository;
  else if (url.pathname === base + '/git/commits/main') data = { sha: 'abc', commit: { message: 'tip' } };
  else if (url.pathname === base + '/commits') data = [{ sha: second ? 'match' : 'other', commit: { message: second ? 'login fix' : 'unrelated' }, author: user }];
  else if (url.pathname === '/api/v1/repos/search') data = { ok: true, data: [second ? repository : { ...repository, id: 5, full_name: 'other/else', description: 'else' }] };
  else if (url.pathname.endsWith('/issues') || url.pathname.endsWith('/pulls') || url.pathname === '/api/v1/repos/issues/search') data = [{ ...issue, ...(second ? {} : { id: 10, number: 10, title: 'unrelated' }), ...(url.pathname.endsWith('/pulls') ? { head: { sha: 'abc', ref: 'main' }, base: { sha: 'def', ref: 'main' } } : {}) }];
  else { response.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return; }
  if (mode === 'multiple' && second && url.pathname.endsWith('/issues')) data = [issue, { ...issue, id: 13, number: 13, created_at: '2026-02-01T00:00:00Z' }];
  if (!second && ![base, base + '/git/commits/main'].includes(url.pathname)) {
    url.searchParams.set('page', '2');
    response.setHeader('link', `<${url}>; rel="next"`);
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
});
async function run(executable: string, argv: string[], cwd = scratch, env: NodeJS.ProcessEnv = process.env, expected = 0) {
  const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'close') as [number | null];
  invocations.push({ argv, code });
  assert.equal(code, expected, stdout + stderr);
  return stdout;
}
try {
  await run('npm', ['run', 'build'], root);
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root)) as { filename: string }[];
  const tarball = join(scratch, packed[0]!.filename);
  await run('npm', ['install', '--offline', '--prefix', join(scratch, 'prefix'), '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const bin = join(scratch, 'prefix/node_modules/@knowttl/gitea-axi/dist/cli.js');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  const config = join(scratch, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, defaultProfile: 'test', profiles: { test: { origin, tokenOrigin: origin, allowInsecureHttp: true, token: { env: 'S5_TOKEN' } } } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, S5_TOKEN: canary, NODE_OPTIONS: '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url)) };
  const invoke = async (args: string[], code = 0) => {
    const stdout = await run(process.execPath, [bin, ...args, '--config', config], scratch, env, code);
    assert(!stdout.includes(canary));
    const result = decode(stdout) as Record<string, unknown>;
    if (host && !args.includes('--help') && (args[0] === 'search' && args[1] !== 'code' && code === 0 || args[0] === 'run' && args[1] === 'list')) {
      assert.deepEqual(await host.invoke(args, code), result);
    }
    return result;
  };
  let fixture: { revision: string; manifestSha256: string } | null = null;
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(String(bytes)) as { fixtureCommit: string };
    fixture = { revision: manifest.fixtureCommit, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token: canary });
  }
  if (task === 'S5.1') {
    const output = await invoke(['run', 'list', '--repo', 'sample/demo', '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push', '--status', 'success', '--commit', 'abc', '--fields', 'id,status']);
    assert.deepEqual(output.items, [{ id: 12, status: 'success' }]);
    for (const [command, args] of [['run', ['view', 'watch', 'rerun', 'cancel', 'delete', 'download']], ['workflow', ['list', 'view', 'run', 'enable', 'disable']]] as const) {
      for (const action of args) {
        const before = requests.length;
        const gap = await invoke([command, action, ...(action === 'list' ? [] : ['12'])], 1);
        assert.equal((gap.error as { code: string }).code, 'CAPABILITY_GAP');
        assert.equal(requests.length, before);
        const help = await invoke([command, action, '--help']); assert.equal(help.command, `gitea-axi ${command} ${action}`);
      }
    }
    for (const args of [['--user', 'alice'], ['--fields', 'conclusion']]) {
      const before = requests.length;
      await invoke(['run', 'list', '--repo', 'sample/demo', ...args], args[0] === '--fields' ? 2 : 1);
      assert.equal(requests.length, before);
    }
    mode = 'invalid';
    assert.equal(((await invoke(['run', 'list', '--repo', 'sample/demo'], 1)).error as { code: string }).code, 'INVALID_RESPONSE');
  } else {
    for (const kind of ['issues', 'prs', 'repos', 'commits']) {
      const output = await invoke(['search', kind, 'login', '--repo', 'sample/demo', '--limit', '1', ...(kind === 'issues' || kind === 'prs' ? ['--author', 'alice', '--assignee', 'alice', '--label', 'unknown,bug'] : kind === 'repos' ? ['--language', 'Go', '--stars', '>50'] : ['--author', 'alice'])]);
      const expected = kind === 'repos' ? [{ id: 4, full_name: 'sample/demo', description: 'login tool' }] : kind === 'commits' ? [{ sha: 'match', message: 'login fix', author: user }] : [{ repository: 'sample/demo', number: 11, title: 'login bug', state: 'open' }];
      assert.deepEqual(output.items, expected);
      assert.equal(output.total, 1);
      if (kind === 'commits') assert.equal((output.scope as Record<string, unknown>).revision, 'abc');
    }
    for (const args of [['issues', 'author:alice'], ['issues', 'login', '--fields', 'authorAssociation'], ['prs', 'login', '--review', 'approved'], ['code', 'login']]) {
      const before = requests.length; await invoke(['search', ...args], args[1] === 'author:alice' || args.includes('--fields') ? 2 : 1); assert.equal(requests.length, before);
    }
    assert.deepEqual((await invoke(['search', 'issues', 'login', '--repo', 'sample/demo', '--label', 'unknown'])).items, []);
    assert.deepEqual((await invoke(['search', 'issues', 'login', '--repo', 'sample/demo', '--author', 'bob'])).items, []);
    assert.deepEqual((await invoke(['search', 'issues', 'login', '--owner', 'sample', '--author', 'alice'])).items, [{ repository: 'sample/demo', number: 11, title: 'login bug', state: 'open' }]);
    mode = 'multiple';
    const capped = await invoke(['search', 'issues', 'login', '--repo', 'sample/demo', '--sort', 'created', '--limit', '1']);
    assert.deepEqual(capped.items, [{ repository: 'sample/demo', number: 13, title: 'login bug', state: 'open' }]);
    assert.equal(capped.total, 2); assert.equal(capped.continuation, true);
  }
  mode = 'denied';
  const denied = await invoke(task === 'S5.1' ? ['run', 'list', '--repo', 'sample/demo'] : ['search', 'issues', 'login', '--repo', 'sample/demo'], 1);
  assert.equal((denied.error as { code: string }).code, 'PERMISSION_DENIED');
  const assigned = task === 'S5.1' ? ['009', '025', '026', '027', '028'] : ['003', '018', '019', '020', '024', '027', '028', '034', '038', '045', '046', '047'];
  const report = { task, assignedOperations: assigned.map(id => 'OP-' + id), assignedOutcomes: assigned.map(id => 'AC-' + id),
    commandIds: task === 'S5.1' ? ['C081', 'C082', 'C083', 'C084', 'C085', 'C086', 'C087', 'C116', 'C117', 'C118', 'C119', 'C120'] : ['C088', 'C089', 'C090', 'C091', 'C092'],
    crossCutting: task === 'S5.2' ? ['CX-001'] : [], result: 'passed', channel: 'offline-fake',
    sourceHead: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), packageSha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
    invocations, fixture, artium: host ? 'passed' : 'skipped: opt-in frozen fixture required', live: 'pending commissioning', nativeWindows: 'pending',
    pending: 'Task/run identity; run details, jobs, conclusions, watch, logs and artifacts; workflow control; indexed code search. Gap responses are disclosure only.' };
  if (process.env.GITEA_AXI_REPORT_DIR) await writeFile(join(process.env.GITEA_AXI_REPORT_DIR, task + '.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(task + ' passed: installed package, paged fake responses, rejected gaps, permission failure; Artium: ' + (host ? 'passed' : 'skipped: opt-in frozen fixture required'));
} finally {
  await host?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
}
