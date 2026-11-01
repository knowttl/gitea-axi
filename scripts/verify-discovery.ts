import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

type Row = Record<string, unknown>;
interface Baseline { id: string; path: string; expectedOutcome: string; flags: { name: string }[] }
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3]!;
assert(['S6.3', 'S6.4'].includes(task));
const scratch = await mkdtemp(join(tmpdir(), 'gitea-s6-discovery-'));
const assertions: string[] = [];
const invocations: { executable: string; args: string[]; code: number | null }[] = [];
const requests: string[] = [];
const canary = 'CANARY-S6-discovery-not-a-real-token';
// Synthetic responses use the retained 1.23.4 Repository and ContentsResponse schemas.
let origin = '';
let denied = false;
const server = createServer((request, response) => {
  requests.push(request.method + ' ' + request.url);
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.authorization, 'token ' + canary);
  if (denied) { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'denied ' + canary })); return; }
  const path = new URL(request.url!, origin).pathname;
  const data: Record<string, unknown> = {
    '/api/v1/version': { version: '1.23.4' },
    '/swagger.v1.json': { info: { version: '1.23.4' }, paths: { '/version': {} } },
    '/api/v1/repos/sample/demo': { id: 1008, full_name: 'sample/demo', default_branch: 'main' },
    '/api/v1/repos/sample/demo/contents': [{ type: 'file', name: 'README.md', path: 'README.md', sha: 'a'.repeat(40), size: 5, encoding: 'base64', content: 'aGVsbG8=' }],
    '/api/v1/repos/sample/demo/contents/README.md': { type: 'file', name: 'README.md', path: 'README.md', sha: 'a'.repeat(40), size: 5, encoding: 'base64', content: 'aGVsbG8=' },
  };
  response.writeHead(Object.hasOwn(data, path) ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(data[path] ?? {}));
});
async function run(executable: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env, expected = 0) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'close') as [number | null];
  invocations.push({ executable, args, code });
  assert.equal(code, expected, stdout + stderr);
  assert(!(stdout + stderr).includes(canary), 'No token in process output');
  return expected === 0 ? stdout : stdout + stderr;
}
function check(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); assertions.push(name); }
let host: Awaited<ReturnType<typeof readHost>> | undefined;
let fixture: unknown = 'skipped: opt-in frozen Artium fixture required';
let packageSha256 = '';
let result = 'failed';
const coverage: Row[] = [];
try {
  await run('npm', ['run', 'build']);
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string }[];
  const tarball = join(scratch, packed[0]!.filename);
  packageSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const prefix = join(scratch, 'prefix');
  await run('npm', ['install', '--offline', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], scratch);
  const installed = join(prefix, 'node_modules/@knowttl/gitea-axi');
  const bin = join(installed, 'dist/cli.js');
  const binBefore = await readFile(bin);
  const home = join(scratch, 'home'); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, S6_TOKEN: canary,
    NODE_OPTIONS: '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url)) };
  const invoke = async (args: string[], code = 0, overrides: NodeJS.ProcessEnv = {}) => decode(await run(process.execPath, [bin, ...args], scratch, { ...env, ...overrides }, code)) as Row;
  const summary = await invoke(['capabilities']);
  check('All baseline leaves, flags, globals and PR fields are accounted for without claiming parity', summary.counts, { commands: 124, commandFlags: 397, globals: 4, prFields: 46, fullParity: 0 });
  const baseline = (JSON.parse(await readFile(join(installed, 'schemas/catalogue.json'), 'utf8')) as { commands: Baseline[] }).commands;
  check('Catalogue IDs are complete and unique', (summary.commands as Row[]).map(row => row.id), Array.from({ length: 124 }, (_, index) => 'C' + String(index + 1).padStart(3, '0')));
  const inventory = JSON.parse(await readFile(join(installed, 'generated/host-inventory.json'), 'utf8')) as { commands: { path: string[]; flags: Record<string, { type: string; gap?: string }>; gap?: string }[] };
  for (const row of baseline) {
    const detail = await invoke(['capabilities', row.id]);
    const entry = (detail.commands as Row[])[0]!;
    check(row.id + ' retains source outcome and every captured flag', [entry.expectedOutcome, (entry.flags as Row[]).map(flag => flag.name)], [row.expectedOutcome, row.flags.map(flag => flag.name)]);
    coverage.push({ id: row.id, flags: entry.flags, expectedOutcome: row.expectedOutcome, status: entry.status });
    if (row.path === '--version') continue;
    const path = row.path.startsWith('api ') ? 'api' : row.path === 'update --check' ? 'update' : row.path;
    const command = inventory.commands.find(command => command.path.join(' ') === path)!;
    const help = await invoke([...path.split(' '), '--help']);
    const flags = (help.flags as Row[]).map(flag => flag.flag);
    check(row.id + ' exposes captured flags in installed help', row.flags.every(flag => flags.includes(flag.name === '-X' ? '--method' : flag.name)), true);
    if ((task === 'S6.3' && command.gap) || (task === 'S6.4' && ['setup hooks', 'update'].includes(path))) {
      const before = requests.length;
      check(row.id + ' refuses before credentials or requests', ((await invoke(row.path.split(' '), 1)).error as Row).code, 'CAPABILITY_GAP');
      check(row.id + ' makes no request', requests.length, before);
    }
  }
  check('Unknown capability ID is actionable usage', ((await invoke(['capabilities', 'C125'], 2)).error as Row).code, 'USAGE');
  for (const flags of [['--jq', '.id'], ['--template', '{{.id}}']]) check('Reject unimplemented engine ' + flags[0], ((await invoke(['api', 'GET', 'version', ...flags], 1)).error as Row).code, 'CAPABILITY_GAP');
  for (const args of [['issue', 'create', '--title', 'No creation', '--project', 'board'], ['pr', 'create', '--title', 'No creation', '--draft'], ['pr', 'ready', '7', '--undo'], ['issue', 'transfer', '1', '--to-repo', 'sample/other']]) {
    check('Unsupported workflow refuses before input and effects: ' + args.slice(0, 2).join(' '), ((await invoke(args, 1)).error as Row).code, 'CAPABILITY_GAP');
  }
  check('HEAD is a versioned contract gap', ((await invoke(['api', 'HEAD', 'version'], 1)).error as Row).code, 'CAPABILITY_GAP');
  check('Unknown flag remains usage', ((await invoke(['project', 'list', '--unknown'], 2)).error as Row).code, 'USAGE');
  check('Gap refusals leave disposable configuration untouched', await readdir(home), []);
  check('Update refusals preserve installed executable bytes', await readFile(bin), binBefore);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  const config = join(scratch, 'config.json');
  const profile = { origin, tokenOrigin: origin, allowInsecureHttp: true, token: { env: 'S6_TOKEN' } };
  await writeFile(config, JSON.stringify({ version: 1, defaultProfile: 'other', profiles: { test: profile, other: { ...profile, origin: 'https://other.test', tokenOrigin: 'https://other.test', token: { env: 'MISSING_CANARY' } } } }), { mode: 0o600 });
  const repo = ['repo', 'view', '-R', 'sample/demo', '--config', config];
  check('Hostname selects matching profile before unrelated default and secrets', (await invoke([...repo, '--hostname', new URL(origin).host])).repository, { id: 1008, full_name: 'sample/demo', default_branch: 'main' });
  check('GH_HOST selects the same bound profile', (await invoke(repo, 0, { GH_HOST: new URL(origin).host })).repository, { id: 1008, full_name: 'sample/demo', default_branch: 'main' });
  const beforeMismatch = requests.length;
  check('Mismatched hostname refuses before secret resolution', ((await invoke([...repo, '--profile', 'test', '--hostname', 'other.test'], 1)).error as Row).code, 'AUTH_BINDING_MISMATCH');
  check('Mismatched hostname dispatches nothing', requests.length, beforeMismatch);
  for (const path of ['contents', 'contents/README.md']) {
    const output = await invoke(['api', 'GET', 'repos/sample/demo/' + path, '--config', config, '--profile', 'test']);
    const entry = (Array.isArray(output.data) ? output.data[0] : output.data) as Row;
    check('OP-027/028 raw contents ' + path, [entry.name, entry.sha, entry.content], ['README.md', 'a'.repeat(40), 'aGVsbG8=']);
  }
  denied = true;
  check('Contents permission failures remain explicit', ((await invoke(['api', 'GET', 'repos/sample/demo/contents', '--config', config, '--profile', 'test'], 1)).error as Row).code, 'PERMISSION_DENIED');
  denied = false;
  if (task === 'S6.3') {
    await run(process.execPath, ['--import', fileURLToPath(new URL('deny-network.ts', import.meta.url)), 'scripts/verify.mjs', '--task', 'S2.3']);
    assertions.push('Existing S2.3 installed journeys verify all 46 selected PR fields, numeric IDs and partial commit status rollups');
  } else {
    const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version: string };
    for (const flag of ['--version', '-v', '-V']) check('Offline version alias ' + flag, await run(process.execPath, [bin, flag], scratch, env), pkg.version + '\n');
    const copy = join(scratch, 'freshness'); await mkdir(copy);
    for (const path of ['src', 'schemas', 'generated', 'evidence/docs', 'scripts/generate.mjs', 'tsconfig.json', 'package.json', 'axi-credential.schema.json']) await cp(join(root, path), join(copy, path), { recursive: true });
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    await writeFile(join(copy, 'src/registry.ts'), await readFile(join(copy, 'src/registry.ts'), 'utf8') + '\ncommands.push({path:["freshness-canary"],description:"Registry drift",flags:{},effect:"gap"});\n');
    const stale = await run('npm', ['run', 'generate:check'], copy, process.env, 1);
    assert.match(stale, /Stale generated artifact/);
    await run('npm', ['run', 'generate'], copy);
    await run('npm', ['run', 'generate:check'], copy);
    const generatedHelp = decode(await readFile(join(copy, 'generated/help.txt'), 'utf8')) as { commands: { path: string[] }[] };
    check('Generated help includes new registry command', generatedHelp.commands.at(-1)?.path, ['freshness-canary']);
    const generatedInventory = JSON.parse(await readFile(join(copy, 'generated/host-inventory.json'), 'utf8')) as { commands: { path: string[] }[] };
    check('Generated inventory includes new registry command', generatedInventory.commands.at(-1)?.path, ['freshness-canary']);
    assert((await readFile(join(copy, 'generated/SKILL.md'), 'utf8')).includes('`npx -y @knowttl/gitea-axi freshness-canary --help`'));
    assertions.push('Real generator refuses stale discovery artifacts after registry drift');
  }
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST, 'Frozen fixture manifest required');
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(String(bytes)) as { fixtureCommit: string };
    const head = (await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'rev-parse', 'HEAD'])).trim();
    check('Exact frozen fixture revision', head, manifest.fixtureCommit);
    fixture = { revision: head, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token: canary });
    const before = requests.length;
    for (const args of [['setup', 'hooks'], ['update'], ['update', '--check']]) await host.refuse(args, 'INVALID_INPUT');
    for (const args of [['repo', 'view', '--repo', 'sample/demo', '--config', config], ['repo', 'view', '--repo', 'sample/demo', '--origin', origin]]) await host.refuse(args, 'FLAG_BLOCKED');
    check('Hosted admission refuses hooks, updates and configuration before effects', requests.length, before);
  }
  result = 'passed';
} finally {
  if (host) await host.close();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  const report = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  const operationIds = task === 'S6.3' ? ['001', '002', '027', '028', '034', '038', '066'] : ['001', '002', '004'];
  await writeFile(report, JSON.stringify({ task, result, sourceHead: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), packageSha256, assertions, invocations, requests, coverage, artium: fixture,
    operations: operationIds.map(id => 'OP-' + id), outcomes: operationIds.map(id => 'AC-' + id),
    credentialCases: task === 'S6.4' ? ['CS-005', 'CS-007', 'CS-009'] : [], crossCuttingCases: task === 'S6.3' ? ['CX-007'] : [],
    pending: ['C096 hook installation/repair', 'C121 baseline dashboard sections', 'C122/C123 updater installation/integrity/rollback and distribution check', 'native Windows', 'live commissioning'] }, null, 2));
  console.log(task + ' ' + result + '; Artium: ' + (host ? result : fixture) + '; report: ' + report);
  await rm(scratch, { recursive: true, force: true });
}
