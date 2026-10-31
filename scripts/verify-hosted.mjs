import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';

const root = fileURLToPath(new URL('../', import.meta.url));
assert(process.env.GITEA_AXI_ARTIUM_ROOT, 'GITEA_AXI_ARTIUM_ROOT must select the reviewed local Artium fixture');
const host = await realpath(process.env.GITEA_AXI_ARTIUM_ROOT);
const scenario = JSON.parse(await readFile(join(root, 'test/fixtures/S1.2/scenario.json'), 'utf8'));
assert.equal(scenario.task, 'S1.2');
assert.deepEqual(scenario.operations, ['OP-001', 'OP-002', 'OP-004']);
assert.deepEqual(scenario.outcomes, ['AC-001', 'AC-002', 'AC-004']);
assert.deepEqual(scenario.credentialCases, ['CS-003', 'CS-004', 'CS-009', 'CS-010', 'CS-011', 'CS-012', 'CS-013']);
assert.deepEqual(scenario.crossCuttingCases, []);
assert.deepEqual(scenario.commands.map(command => [command.id, command.capturedFlags]), [['C075', ['--repo']]]);
const report = { ...scenario, channel: 'offline-fake', invocations: [], assertions: [], requests: [], hostGates: null };
const scratch = await mkdtemp(join(tmpdir(), 'gitea-axi-S1.2-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const canary = 'CANARY-injected-"/%-token';
const poisons = ['HOME', 'XDG', 'tea', 'git-helper'].map(name => 'CANARY-developer-' + name);
const passwords = { bootstrap: 'CANARY-bootstrap-password', replacement: 'CANARY-replacement-password' };
const sensitiveValues = [canary, ...poisons, ...Object.values(passwords)];
const secretForms = sensitiveValues.flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
const events = new EventEmitter();
const command = ['repo', 'view', '--repo', 'sample-owner/sample-repo'];
let mode = 'success';
let vendor;
let foreign;
let server;
let serverLog = '';
let headers = {};
let hostUrl;
let clientEnv;
let bin;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function expect(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  report.assertions.push(name);
}
function assertNoSecrets(outputs) {
  if (outputs && typeof outputs === 'object') {
    for (const value of Object.values(outputs)) assertNoSecrets(value);
    return;
  }
  if (typeof outputs !== 'string') return;
  for (const form of secretForms) {
    assert(!outputs.includes(form), 'Secret in client output, server output, audit or journal');
  }
}
async function run(executable, argv, options = {}) {
  const invocation = { executable, argv, cwd: options.cwd ?? root };
  report.invocations.push(invocation);
  const child = spawn(executable, argv, { cwd: invocation.cwd, env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(options.stdin);
  const [code, signal] = await once(child, 'close');
  Object.assign(invocation, { code, signal });
  assertNoSecrets([stdout, stderr]);
  assert.equal(code, options.code ?? 0, `${executable} failed: ${stdout}\n${stderr}`);
  return stdout;
}
async function api(path, method = 'GET', body, status = 200, signal) {
  const response = await fetch(hostUrl + path, { method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  const result = await response.json();
  assertNoSecrets(result);
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
async function clean(name) {
  expect(name, await readdir(join(scratch, 'calls')), []);
}
async function profile(origin, token) {
  const path = join(scratch, 'standalone.json');
  await writeFile(path, JSON.stringify({ version: 1, defaultProfile: 'test', profiles: {
    test: { origin, tokenOrigin: origin, token, allowInsecureHttp: true },
  } }), { mode: 0o600 });
  return path;
}
async function filesBelow(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(target));
    else result.push(target);
  }
  return result;
}
try {
  expect('pinned fixture ancestry', await run('git', ['merge-base', '--is-ancestor', scenario.fixtureRevision, 'HEAD'], { cwd: host }), '');
  report.artiumRevision = (await run('git', ['rev-parse', 'HEAD'], { cwd: host })).trim();
  await run(npm, ['run', 'build']);
  const [packed] = JSON.parse(await run(npm, ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch]));
  const tarball = join(scratch, packed.filename);
  report.package = { sha256: hash(await readFile(tarball)), integrity: packed.integrity };
  const cache = (await run(npm, ['config', 'get', 'cache'])).trim();
  const prefix = join(scratch, 'prefix');
  await run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--prefix', prefix, tarball]);
  const installed = join(prefix, 'node_modules/@knowttl/gitea-axi');
  bin = await realpath(join(installed, 'dist/cli.js'));
  assert(!relative(prefix, bin).startsWith('..'), 'Runner must execute the installed tarball');
  expect('shipped profile schema', await json(join(installed, 'axi-credential.schema.json')), await json(join(root, 'axi-credential.schema.json')));
  expect('host consumes the shipped profile contract', (await json(join(host, 'tools/inventories/gitea-axi.json'))).credentialSchema, await json(join(installed, 'axi-credential.schema.json')));
  const routes = {
    '/api/v1/version': await json(join(root, 'evidence/fixtures/P-001.json')),
    '/swagger.v1.json': await json(join(root, 'evidence/fixtures/P-002.json')),
    '/api/v1/repos/sample-owner/sample-repo': await json(join(root, 'evidence/fixtures/P-004.json')),
  };
  let foreignRequests = 0;
  foreign = createServer((request, response) => { foreignRequests++; response.end('{}'); });
  foreign.listen(0, '127.0.0.1');
  await once(foreign, 'listening');
  const other = 'http://127.0.0.1:' + foreign.address().port;
  vendor = createServer((request, response) => {
    report.requests.push({ method: request.method, path: request.url, injectedIdentity: request.headers.authorization === 'token ' + canary });
    if (request.headers.authorization !== 'token ' + canary || request.method !== 'GET' || !(request.url in routes)) {
      response.writeHead(403, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    events.emit('vendor-request');
    if (mode === 'hang') return;
    if (mode === 'redirect') { response.writeHead(302, { location: other }).end(); return; }
    if (mode === 'error') { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: canary })); return; }
    let body = routes[request.url];
    if (mode === 'secret' && request.url.endsWith('/version')) body = { version: canary + JSON.stringify(canary) + encodeURIComponent(canary) };
    if (mode === 'large' && request.url.endsWith('/version')) body = { version: 'x'.repeat(16_384) };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  vendor.listen(0, '127.0.0.1');
  await once(vendor, 'listening');
  const origin = 'http://127.0.0.1:' + vendor.address().port;
  const home = join(scratch, 'developer');
  await mkdir(join(home, '.config/gitea-axi'), { recursive: true });
  await mkdir(join(home, '.config/tea'), { recursive: true });
  await writeFile(join(home, '.config/gitea-axi/config.json'), poisons[0]);
  await writeFile(join(home, '.config/tea/config.yml'), poisons[2]);
  await writeFile(join(home, '.gitconfig'), `[credential]\nhelper = ${poisons[3]}\n`);
  const standaloneEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GITEA_AXI_TEST_TOKEN: canary };
  const config = await profile(origin, { env: 'GITEA_AXI_TEST_TOKEN' });
  const standalone = async (args = command, code = 0, env = {}) => {
    const output = await run(process.execPath, [bin, ...args], {
      env: { ...standaloneEnv, GITEA_AXI_CONFIG: config, ...env }, code,
    });
    assertNoSecrets(decode(output));
    return output;
  };
  expect('CS-004 environment reference', decode(await standalone()).repository, scenario.expected.repository);
  const tokenFile = join(scratch, 'token');
  await writeFile(tokenFile, canary + '\n', { mode: 0o600 });
  await profile(origin, { file: tokenFile });
  expect('CS-004 protected file reference', decode(await standalone()).repository, scenario.expected.repository);
  for (const token of [canary, { env: 'bad-name' }, { stored: true }]) {
    await profile(origin, token);
    expect('CS-003 invalid token reference', decode(await standalone(command, 1)).error.code, 'CONFIG_INVALID');
  }
  await profile(origin, { env: 'GITEA_AXI_TEST_TOKEN' });
  expect('CS-003 secret argv refusal', decode(await standalone([...command, '--token=' + canary], 1)).error.code, 'CONFIG_INVALID');
  const mismatch = await json(config);
  mismatch.profiles.test.origin = other;
  mismatch.profiles.test.token = { file: join(scratch, 'must-not-read') };
  await writeFile(config, JSON.stringify(mismatch));
  expect('CS-012 binding checked before secret file', decode(await standalone(command, 1)).error.code, 'AUTH_BINDING_MISMATCH');
  await profile(origin, { env: 'GITEA_AXI_TEST_TOKEN' });
  expect('CS-012 override binding', decode(await standalone([...command, '--origin', other], 1)).error.code, 'AUTH_BINDING_MISMATCH');
  const noHttp = await json(config);
  noHttp.profiles.test.allowInsecureHttp = false;
  await writeFile(config, JSON.stringify(noHttp));
  expect('CS-011 missing HTTP exception', decode(await standalone(command, 1)).error.code, 'CONFIG_INVALID');
  await profile(origin, { env: 'GITEA_AXI_TEST_TOKEN' });
  mode = 'redirect';
  expect('CS-012 redirect refusal', decode(await standalone(command, 1)).error.code, 'TRANSPORT_ERROR');
  expect('CS-012 foreign origin untouched', foreignRequests, 0);
  mode = 'secret';
  await standalone();
  mode = 'success';
  const bootstrap = join(scratch, 'bootstrap');
  await writeFile(bootstrap, passwords.bootstrap, { mode: 0o600 });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolveClose => reservation.close(resolveClose));
  const launcher = `
    const { serverDefaults, toolPaths, toolCredentialSchemaPaths, runnerLimits } = await import('./dist/src/server/config.js');
    serverDefaults.host = '127.0.0.1'; serverDefaults.port = Number(process.env.GITEA_TEST_PORT);
    serverDefaults.temporaryDirectory = process.env.GITEA_TEST_SCRATCH + '/calls';
    toolPaths['gitea-axi'] = process.env.GITEA_TEST_BIN;
    toolCredentialSchemaPaths['gitea-axi'] = process.env.GITEA_TEST_SCHEMA;
    runnerLimits.timeoutMs = 2500; runnerLimits.outputBytesPerStream = 4096;
    await import('./dist/src/server/main.js');
  `;
  // The server is real. Only its disposable listener, installed package and limits differ from production defaults.
  const hostEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
    GITEA_AXI_TOKEN: poisons[1], TEA_CONFIG: join(home, '.config/tea/config.yml'), GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    ARTIUM_AXI_MASTER_KEY: randomBytes(32).toString('base64'), ARTIUM_AXI_DATABASE_FILE: join(scratch, 'data/artium.db'),
    ARTIUM_AXI_ADMIN_USERNAME: 'fixture-admin', ARTIUM_AXI_ADMIN_PASSWORD_FILE: bootstrap,
    GITEA_TEST_SCRATCH: scratch, GITEA_TEST_PORT: String(port), GITEA_TEST_BIN: bin, GITEA_TEST_SCHEMA: join(installed, 'axi-credential.schema.json') };
  // An ephemeral listening port is read from the server's structured log below.
  server = spawn(process.execPath, ['--input-type=module', '-e', launcher], { cwd: host, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  report.invocations.push({ executable: process.execPath, argv: ['--input-type=module', '-e', launcher], cwd: host, role: 'real-server' });
  const ready = new Promise((resolveReady, reject) => {
    AbortSignal.timeout(30_000).addEventListener('abort', () => reject(new Error('Real server did not become ready within 30 seconds')), { once: true });
    const consume = chunk => {
      serverLog += chunk;
      for (const line of serverLog.split('\n')) {
        try { const record = JSON.parse(line); if (record.event === 'listening') resolveReady(record); } catch { /* Incomplete log line. */ }
      }
    };
    server.stdout.on('data', consume);
    server.stderr.on('data', consume);
    server.once('exit', code => reject(new Error(`Real server exited ${code}: ${serverLog}`)));
  });
  await ready;
  hostUrl = 'http://127.0.0.1:' + port;
  clientEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(scratch, 'client'), ARTIUM_AXI_URL: hostUrl, ARTIUM_AXI_TEST_HTTP: '1' };
  const client = (args, stdin, code = 0) => run(process.execPath, [join(host, 'dist/cli/artium-axi.mjs'), ...args], { env: clientEnv, stdin, code });
  await client(['login', '--username', 'fixture-admin', '--password-stdin'], passwords.bootstrap, 1);
  await client(['passwd', '--password-stdin'], passwords.replacement);
  await client(['login', '--username', 'fixture-admin', '--password-stdin'], passwords.replacement);
  const session = await json(join(scratch, 'client/artium-axi/session.json'));
  headers = { authorization: 'Bearer ' + session.accessToken };
  const reauth = await api('/v1/auth/reauth', 'POST', { password: passwords.replacement });
  headers['x-artium-reauth-ticket'] = reauth.ticket;
  const toolPath = '/v1/admin/tools/gitea-axi';
  const tool = await api(toolPath);
  await api(toolPath + '/credential', 'PUT', { expectedRevision: 0, expectedToolRevision: tool.revision,
    value: { origin, tokenOrigin: origin, token: canary, allowInsecureHttp: true } });
  const configured = await api(toolPath);
  for (const value of [
    { origin, tokenOrigin: origin, token: canary },
    { origin, tokenOrigin: other, token: canary, allowInsecureHttp: true },
  ]) {
    const refused = await api(toolPath + '/credential', 'PUT', {
      expectedRevision: 1, expectedToolRevision: configured.revision, value,
    }, 400);
    expect('CS-013 HTTP allowance belongs only to the selected credential', refused.error.code, 'INVALID_INPUT');
  }
  await api(toolPath, 'PATCH', { enabled: true, expectedRevision: configured.revision });
  const role = await api('/v1/admin/roles', 'POST', { name: 'synthetic-reader' }, 201);
  await api('/v1/admin/roles/' + role.id + '/tools', 'PUT', { tools: ['gitea-axi'], expectedRevision: role.revision });
  const users = await api('/v1/admin/users');
  const user = users.users.find(user => user.username === 'fixture-admin');
  await api('/v1/admin/users/' + user.id + '/roles', 'PUT', { roleIds: [role.id], expectedRevision: user.revision });
  const hosted = decode(await client(['gitea-axi', ...command]));
  assertNoSecrets(hosted);
  expect('AC-001 hosted version', hosted.server.version, scenario.expected.version);
  expect('AC-002 hosted specification', hosted.server.specification_version, scenario.expected.specificationVersion);
  expect('AC-002 exact hosted paths', hosted.server.specification_paths, Object.keys(routes['/swagger.v1.json'].paths).length);
  expect('AC-004 hosted repository and branch', hosted.repository, scenario.expected.repository);
  await clean('cleanup after success');
  const runPath = '/v1/tools/gitea-axi/run';
  for (const args of [['config', 'path'], ['hooks'], ['update'], ['repo', 'clone'], [...command, '--origin', other], [...command, '--token', canary]]) {
    const refusal = await api(runPath, 'POST', { args }, 400);
    assert(['INVALID_INPUT', 'FLAG_BLOCKED'].includes(refusal.error.code));
    report.assertions.push('host admission refusal ' + args[0]);
  }
  for (const failure of ['error', 'redirect', 'secret', 'large']) {
    mode = failure;
    const result = await api(runPath, 'POST', { args: command });
    if (failure === 'large') expect('runner output cap', result.truncated.stdout, true);
    else if (failure === 'secret') assertNoSecrets(decode(result.stdout));
    else expect('hosted failure ' + failure, result.exitCode, 1);
    await clean('cleanup after ' + failure);
  }
  mode = 'hang';
  const requestSeen = once(events, 'vendor-request');
  const timed = api(runPath, 'POST', { args: command }, 504);
  await requestSeen;
  const callDirectories = await readdir(join(scratch, 'calls'));
  assert.equal(callDirectories.length, 1);
  const privatePath = join(scratch, 'calls', callDirectories[0], 'config/gitea-axi/config.json');
  const privateProfile = await json(privatePath);
  expect('CS-010 private artium profile', privateProfile, { version: 1, defaultProfile: 'artium', profiles: { artium: {
    origin, tokenOrigin: origin, token: { env: 'ARTIUM_SECRET_0' }, allowInsecureHttp: true,
  } } });
  expect('private profile permissions', (await stat(privatePath)).mode & 0o777, 0o600);
  expect('bounded timeout', (await timed).error.code, 'TIMEOUT');
  await clean('cleanup after timeout');
  const controller = new AbortController();
  const cancelSeen = once(events, 'vendor-request');
  const cancelled = api(runPath, 'POST', { args: command }, 200, controller.signal).catch(error => error);
  await cancelSeen;
  controller.abort();
  await cancelled;
  // A subsequent completed public request settles cancellation before inspecting cleanup.
  mode = 'success';
  await client(['gitea-axi', ...command]);
  const audit = await api('/v1/admin/audit?tool=gitea-axi&limit=100');
  const auditText = JSON.stringify(audit);
  assert(audit.records.some(record => record.event === 'run-terminal' && record.outcome === 'CANCELLED' && record.action === 'unknown'), 'Cancellation must be audited');
  assert(audit.records.some(record => record.event === 'run-terminal' && record.exit_code === 0 && record.action === 'read'), 'Successful read must be classified');
  await clean('cleanup after cancellation');
  expect('CS-012 no redirected credential traffic', foreignRequests, 0);
  const current = await api(toolPath);
  const reboundOrigin = origin.replace('http:', 'https:');
  const rebound = await api(toolPath + '/credential', 'PUT', {
    expectedRevision: 1, expectedToolRevision: current.revision,
    value: { origin: reboundOrigin, tokenOrigin: reboundOrigin, token: canary, allowInsecureHttp: true },
  });
  expect('CS-012 host writer clears HTTP on rebind', rebound.metadata.allowInsecureHttp, false);
  assert(report.requests.length > 0 && report.requests.every(request => request.injectedIdentity), 'Only injected identity may reach fake Gitea');
  const outputs = [serverLog, auditText];
  for (const path of await filesBelow(join(scratch, 'data'))) if (!path.includes('artium.db')) outputs.push(await readFile(path, 'utf8'));
  assertNoSecrets(outputs);
  assert(process.env.GITEA_AXI_HOST_GATE_REPORT, 'Host regression, container and delivery evidence is required');
  report.hostGates = await json(process.env.GITEA_AXI_HOST_GATE_REPORT);
  for (const name of ['check', 'test:containers', 'test:runner-container']) {
    const gate = report.hostGates.commands.find(gate => gate.name === name);
    assert(gate && gate.exitCode === 0 && gate.scenarios > 0, 'Missing or failed host gate: ' + name);
  }
  expect('host review completed', report.hostGates.review.status, 'completed');
  await run('git', ['merge-base', '--is-ancestor', report.hostGates.review.headSha, 'HEAD'], { cwd: host });
  const followupPaths = (await run('git', ['diff', '--name-only', report.hostGates.review.headSha, 'HEAD'], { cwd: host })).trim();
  expect('host changes after review are the approved fixture test repair', followupPaths, 'test/admission-fixture.test.ts');
  expect('host follow-up approval covers the selected revision', report.hostGates.review.approvedFollowupHeadSha, report.artiumRevision);
  const inputs = (await run(process.execPath, ['--input-type=module', '-e', `const {buildInputs,digest}=await import('./scripts/build-inputs.mjs');console.log(JSON.stringify({inputs:buildInputs(),output:digest(['dist/'])}));`], { cwd: host })).trim();
  expect('host evidence matches current inputs and compiled output', JSON.parse(inputs), report.hostGates.candidate);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failure = error.message;
  throw error;
} finally {
  if (server && server.exitCode === null) { const closed = once(server, 'close'); server.kill('SIGTERM'); await closed; }
  for (const service of [vendor, foreign]) if (service) { service.closeAllConnections(); await new Promise(resolveClose => service.close(resolveClose)); }
  const path = resolve(process.env.GITEA_AXI_REPORT ?? scratch + '-report.json');
  // Negative secret-argument probes must not expose their input in retained proof.
  const serialized = secretForms.reduce((output, form) => output.replaceAll(form, '[REDACTED]'), JSON.stringify(report, null, 2));
  await writeFile(path, serialized + '\n');
  console.log(`S1.2 ${report.result}; report: ${path}`);
  await rm(scratch, { recursive: true, force: true });
}
