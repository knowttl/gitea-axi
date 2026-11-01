import './deny-network.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { Client } from '../dist/transport.js';

type Row = Record<string, unknown>;
interface Output { items: Row[]; data: Row; identity: Row; error: { code: string; reason: string; operation: string }; help: string[]; sections: Record<string, { data: Row; items: Row[]; help: string[]; code: string }>; unfiltered_total: number; total: number; passed: number; failed: number; pending: number; commands: string[] }
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/live-reads.json', import.meta.url), 'utf8')) as Record<string, Row>;
const scratch = await mkdtemp(join(tmpdir(), 'gitea-live-reads-'));
const base = '/api/v1/repos/sample/demo';
let origin = '', mode = '', statusReads = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url!, origin).pathname;
  const routes: Record<string, unknown> = {
    [base]: fixture.repository, [base + '/pulls']: [fixture.pull], [base + '/pulls/1']: fixture.pull,
    [base + '/contents/README.md']: fixture.contents, [base + '/releases']: [fixture.release],
    [base + '/commits/abc123/status']: fixture.combined, [base + '/commits/abc123/statuses']: [],
    [base + '/issues']: [{ id: 5, number: 5, title: 'Open', state: 'open' }, { id: 6, number: 6, title: 'Closed', state: 'closed' }],
    [base + '/labels']: [], [base + '/actions/tasks']: fixture.tasks, '/api/v1/user': fixture.account,
  };
  if (mode === 'register-check' && path.endsWith('/status') && statusReads > 0) routes[path] = { sha: 'abc123', statuses: [{ id: 7, context: 'build', status: 'success' }], total_count: 1 };
  if (mode === 'register-check' && path.endsWith('/statuses') && statusReads++ > 0) routes[path] = [{ id: 7, context: 'build', status: 'success' }];
  if (mode === 'absent-route' && path.endsWith('/actions/tasks')) { response.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return; }
  response.setHeader('x-total-count', '2');
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(routes[path]));
});
async function invoke(args: string[], expected = 0, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, NODE_OPTIONS: process.env.NODE_OPTIONS,
      GITEA_AXI_ORIGIN: origin, GITEA_AXI_TOKEN_ORIGIN: origin, GITEA_AXI_TOKEN: '{"env":"TEST_TOKEN"}', TEST_TOKEN: 'synthetic-token', GITEA_AXI_ALLOW_INSECURE_HTTP: 'true', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'close');
  assert.equal(code, expected, stdout + stderr);
  return decode(stdout) as unknown as Output;
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  const repo = ['--repo', 'sample/demo'];
  // D1: open PRs with a null merge SHA work through list and detail reads.
  assert.deepEqual((await invoke(['pr', 'list', ...repo])).items, [{ number: 1, title: 'Open change', state: 'open' }]);
  assert.deepEqual(await invoke(['pr', 'view', '1', ...repo, '--fields', 'mergeCommit']), { mergeCommit: null });
  // D2: ordinary file metadata includes nullable scalar properties.
  assert.deepEqual((await invoke(['api', 'GET', 'repos/sample/demo/contents/README.md'])).data, fixture.contents);
  // D3: standalone and dashboard releases use release fields.
  const release = { id: 2, tag_name: 'v1.0.0-rc1', name: 'Preview', draft: false, prerelease: true, published_at: null };
  assert.deepEqual((await invoke(['release', 'list', ...repo])).items, [release]);
  const dashboard = await invoke(['dashboard', ...repo]);
  assert.deepEqual(dashboard.sections.releases!.items, [release]);
  // D4: a status-less commit has a normal empty check result.
  const checks = await invoke(['pr', 'checks', '1', ...repo], 1);
  assert.deepEqual([checks.items, checks.passed, checks.failed, checks.pending], [[], 0, 0, 0]);
  mode = 'register-check';
  assert.equal((await invoke(['pr', 'checks', '1', ...repo, '--watch', '--timeout', '3', '--interval', '1'])).passed, 1);
  mode = '';
  const detail = await invoke(['pr', 'view', '1', ...repo, '--checks']);
  assert.equal('error' in detail, false);
  // D5: dashboard repository data has a fixed small projection.
  assert.deepEqual(dashboard.sections.repository!.data, { id: 3, full_name: 'sample/demo', default_branch: 'main', private: false, open_issues_count: 2, open_pr_counter: 1, updated_at: '2026-01-01T00:00:00Z' });
  // D6: empty legacy task lists and absent routes disclose capability limits.
  assert.match((await invoke(['run', 'list', ...repo])).help.join(' '), /older than 1.24.*does not establish/);
  assert.match(dashboard.sections.runs!.help.join(' '), /older than 1.24/);
  mode = 'absent-route';
  assert.equal((await invoke(['run', 'list', ...repo], 1)).error.code, 'CAPABILITY_GAP');
  mode = '';
  // D7: a display limit gives an actionable continuation hint.
  assert.match((await invoke(['issue', 'list', ...repo, '--state', 'all', '--limit', '1'])).help.join(' '), /Raise --limit/);
  // D8: only allowlisted non-secret transport causes reach output.
  const originalFetch = globalThis.fetch;
  try {
    for (const [code, expected] of [['ECONNREFUSED', 'ECONNREFUSED'], ['ENOTFOUND', 'ENOTFOUND'], ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'], ['CERT_HAS_EXPIRED', 'TLS error'], ['private-value', 'connection error']]) {
      globalThis.fetch = async () => { throw new TypeError('private detail', { cause: Object.assign(new Error('private detail'), { code }) }); };
      await assert.rejects(new Client('https://example.test').get('/api/v1/user'), { code: 'TRANSPORT_ERROR', message: 'Gitea request failed (' + expected + '); check the selected origin and connection' });
    }
  } finally { globalThis.fetch = originalFetch; }
  // D9: report missing environment variables and the HTTP opt-in key.
  const incomplete = await invoke(['auth', 'status'], 1, { GITEA_AXI_TOKEN_ORIGIN: undefined, GITEA_AXI_TOKEN: undefined, GITEA_AXI_ALLOW_INSECURE_HTTP: undefined });
  assert.equal(incomplete.error.reason, 'Set missing environment variables: GITEA_AXI_TOKEN_ORIGIN, GITEA_AXI_TOKEN');
  const config = join(scratch, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, profiles: { test: { origin, tokenOrigin: origin, token: { env: 'TEST_TOKEN' } } } }), { mode: 0o600 });
  assert.equal((await invoke(['auth', 'status', '--config', config, '--profile', 'test'], 1)).error.reason, 'HTTP requires allowInsecureHttp: true on the selected profile');
  // D10: a secret query parameter is command misuse.
  assert.equal((await invoke(['api', 'GET', 'user?token=synthetic'], 2)).error.code, 'USAGE');
  // D12: the unfiltered count is labeled separately from matched rows.
  const issues = await invoke(['issue', 'list', ...repo]);
  assert.deepEqual([issues.total, issues.unfiltered_total], [1, 2]);
  // D13: identity diagnostics omit account details.
  assert.deepEqual((await invoke(['doctor'])).identity, { id: 4, login: 'sample' });
  // D14: group help and unknown-command errors identify the requested command.
  assert((await invoke(['repo', '--help'])).commands.includes('gitea-axi repo view'));
  assert.equal((await invoke(['bogus'], 2)).error.operation, 'bogus');
  assert.equal((await invoke(['repo'], 2)).error.operation, 'repo');
  console.log('Live-read regressions passed (offline fixtures)');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
}
