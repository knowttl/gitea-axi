import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--task' && ['S2.1', 'S2.2', 'S2.3', 'S2.4'].includes(args[1])) {
  await import('./verify-reads.mjs');
  process.exit(0);
}
assert.deepEqual(args, ['--task', 'S1.1'], 'Select exactly --task S1.1; missing or empty scenario selection fails');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const fixture = name => readJson(join(root, 'evidence', 'fixtures', name + '.json'));
const scenario = await readJson(join(root, 'test/fixtures/S1.1/scenario.json'));
assert.equal(scenario.task, 'S1.1');
assert.deepEqual(scenario.operations, ['OP-001', 'OP-002', 'OP-004']);
assert.deepEqual(scenario.outcomes, ['AC-001', 'AC-002', 'AC-004']);
assert.deepEqual(scenario.commands.map(command => command.id), ['C075']);
assert.deepEqual(scenario.commands[0].capturedFlags, ['--repo']);
const report = {
  task: scenario.task, channel: 'offline-fake', platform: process.platform, arch: process.arch,
  runtime: { node: process.version, nodePin: (await readFile(join(root, '.nvmrc'), 'utf8')).trim() },
  artiumRevision: null, operations: scenario.operations, outcomes: scenario.outcomes,
  credentialCases: scenario.credentialCases, crossCuttingCases: scenario.crossCuttingCases,
  commands: scenario.commands, invocations: [], assertions: [], requests: [],
};
const scratch = await mkdtemp(join(tmpdir(), 'gitea-axi-S1.1-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function run(executable, argv, options = {}) {
  const invocation = { executable, argv, cwd: options.cwd ?? root };
  report.invocations.push(invocation);
  const child = spawn(executable, argv, {
    cwd: invocation.cwd, env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  Object.assign(invocation, { code, signal, stdout, stderr });
  assert.equal(code, options.code ?? 0, `${executable} ${argv.join(' ')} failed\n${stdout}\n${stderr}`);
  return stdout;
}
function expect(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  report.assertions.push({ name, actual, expected });
}
let server;
try {
  const hashes = await readJson(join(root, 'evidence/hashes.json'));
  assert.equal(Object.keys(hashes).length, 5, 'All retained evidence needs a hash');
  for (const [path, expected] of Object.entries(hashes)) {
    expect('evidence hash ' + path, sha256(await readFile(join(root, 'evidence', path))), expected);
  }
  const pkg = await readJson(join(root, 'package.json'));
  report.runtime.packageManagerPin = pkg.packageManager;
  report.runtime.nodeMinimum = pkg.engines.node;
  report.runtime.npm = (await run(npm, ['--version'])).trim();
  expect('Node runtime pin', process.version, 'v' + report.runtime.nodePin);
  expect('npm runtime pin', 'npm@' + report.runtime.npm, pkg.packageManager);
  await run(npm, ['run', 'typecheck']);
  await run(npm, ['run', 'lint']);
  await run(npm, ['run', 'build']);
  await run(process.execPath, ['scripts/verify-credentials.mjs']);
  const packed = JSON.parse(await run(npm, ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch]));
  assert.equal(packed.length, 1, 'Exactly one immutable tarball');
  const tarball = join(scratch, packed[0].filename);
  report.package = { name: pkg.name, version: pkg.version, sha256: sha256(await readFile(tarball)), integrity: packed[0].integrity };
  const prefix = join(scratch, 'prefix');
  await mkdir(prefix);
  const cache = (await run(npm, ['config', 'get', 'cache'])).trim();
  const home = join(scratch, 'home');
  await mkdir(home);
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch,
  };
  await run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--prefix', prefix, tarball], { cwd: scratch, env });
  const installedRoot = join(prefix, 'node_modules', '@knowttl', 'gitea-axi');
  const installedPkg = await readJson(join(installedRoot, 'package.json'));
  const bin = await realpath(join(installedRoot, installedPkg.bin['gitea-axi']));
  const binRelative = relative(prefix, bin);
  assert(!binRelative.startsWith('..') && !isAbsolute(binRelative), 'Installed bin must stay inside the disposable prefix');
  expect('installed package identity', [installedPkg.name, installedPkg.version], [pkg.name, pkg.version]);
  expect('shipped schema', await readJson(join(installedRoot, 'schemas/responses.json')), await readJson(join(root, 'schemas/responses.json')));
  const inventory = await readJson(join(installedRoot, 'generated/host-inventory.json'));
  expect('shipped host inventory', inventory, await readJson(join(root, 'generated/host-inventory.json')));
  expect('host read classification', inventory.commands.filter(command => command.path.join(' ') === 'repo view').map(command => ({ path: command.path, effect: command.effect, operations: command.operations, outcomes: command.outcomes })), [{
    path: ['repo', 'view'], effect: 'read', operations: scenario.operations, outcomes: scenario.outcomes,
  }]);
  const invoke = (argv, code = 0) => run(process.execPath, [bin, ...argv], { cwd: scratch, env, code });
  for (const flag of ['--version', '-v', '-V']) {
    expect('installed version ' + flag, await invoke([flag]), pkg.version + '\n');
  }
  const timings = { floor: [], version: [] };
  for (let sample = 0; sample < 5; sample++) {
    let start = process.hrtime.bigint();
    await run(process.execPath, ['-e', 'console.log(1)'], { cwd: scratch, env });
    timings.floor.push(Number(process.hrtime.bigint() - start));
    start = process.hrtime.bigint();
    await invoke(['--version']);
    timings.version.push(Number(process.hrtime.bigint() - start));
  }
  const median = values => [...values].sort((a, b) => a - b)[2];
  report.versionTiming = { ...timings, maximumFloorRatio: 4 };
  assert(median(timings.version) < 4 * median(timings.floor), 'Version fast path exceeds four times the same-run Node startup floor');
  const help = decode(await invoke(['repo', 'view', '--help']));
  const repoCommand = inventory.commands.find(command => command.path.join(' ') === 'repo view');
  expect('registry-derived installed help', help, { bin, command: 'gitea-axi repo view', description: repoCommand.description,
    flags: Object.entries(repoCommand.flags).map(([name, flag]) => ({ flag: '--' + name, ...flag })),
    examples: ['gitea-axi repo view --help', 'gitea-axi repo view --profile <name>'] });
  const version = await fixture('P-001');
  const specification = await fixture('P-002');
  const repository = await fixture('P-004');
  let mode = 'success';
  const routes = {
    '/api/v1/version': version,
    '/swagger.v1.json': specification,
    '/api/v1/repos/sample-owner/sample-repo': repository,
  };
  server = createServer((request, response) => {
    report.requests.push({ method: request.method, path: request.url });
    if (request.method !== 'GET' || !(request.url in routes) || request.headers.authorization) {
      response.writeHead(400, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const isRepository = request.url === '/api/v1/repos/sample-owner/sample-repo';
    if (isRepository && mode === 'permission') {
      response.writeHead(403, { 'content-type': 'application/json' }).end('{}');
    } else if (isRepository && mode === 'malformed') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{broken');
    } else {
      const body = isRepository && mode === 'missing-branch' ? { ...repository, default_branch: null } : routes[request.url];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = ['repo', 'view', '--repo', 'sample-owner/sample-repo', '--origin', origin, '--allow-insecure-http'];
  const output = decode(await invoke(command));
  expect('AC-001 server version', output.server.version, scenario.expected.version);
  expect('AC-002 specification version', output.server.specification_version, scenario.expected.specificationVersion);
  expect('AC-002 exact specification path count', output.server.specification_paths, Object.keys(specification.paths).length);
  assert(output.server.specification_paths > 0, 'AC-002 paths must be non-empty');
  expect('AC-004 repository identity and default branch', output.repository, scenario.expected.repository);
  expect('equals-form repository selector', decode(await invoke([
    'repo', 'view', '--repo=sample-owner/sample-repo', '--origin', origin, '--allow-insecure-http',
  ])).repository, scenario.expected.repository);
  for (const [failureMode, code] of [
    ['permission', 'PERMISSION_DENIED'], ['malformed', 'INVALID_RESPONSE'], ['missing-branch', 'INVALID_RESPONSE'],
  ]) {
    mode = failureMode;
    const failure = decode(await invoke(command, 1));
    expect('failure ' + failureMode, failure.error.code, code);
    expect('failure has no repository ' + failureMode, failure.repository, undefined);
  }
  const beforeUsage = report.requests.length;
  for (const argv of [
    [...command, '--unknown'],
    [...command, '--repo', 'another-owner/another-repo'],
    [...command, 'another-owner/another-repo'],
    ['repo', 'view', '--origin', origin, '--allow-insecure-http'],
    ['repo', 'view', '--repo', 'sample-owner/sample-repo', '--origin', origin],
  ]) {
    expect('usage refusal', decode(await invoke(argv, 2)).error.code, 'USAGE');
  }
  expect('usage errors dispatch no requests', report.requests.slice(beforeUsage), []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failure = error.message;
  throw error;
} finally {
  if (server) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  const reportPath = resolve(process.env.GITEA_AXI_REPORT ?? scratch + '-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`S1.1 ${report.result}; report: ${reportPath}`);
  await rm(scratch, { recursive: true, force: true });
}
