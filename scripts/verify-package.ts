import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'gitea-axi-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url))].filter(Boolean).join(' '),
};
function run(executable: string, args: string[], cwd = scratch): string {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

// Published sources pinned by the admission inventory; no external fixture is needed at test time.
const modules = ['main', 'api', 'reads', 'ci', 'search', 'writes', 'pulls', 'repo-workflows', 'releases',
  'attachments', 'action-values', 'registry', 'credentials', 'repository', 'private-file', 'error', 'transport'];
const data = ['generated/host-inventory.json', 'generated/routes.json', 'schemas/vendor.json', 'axi-credential.schema.json'];

try {
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], root);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string; bin: Record<string, string> };
  assert.equal(pkg.name, '@knowttl/gitea-axi');
  assert.deepEqual(pkg.bin, { 'gitea-axi': 'dist/cli.js' });
  const licenses = (await readdir(root)).filter(name => /license|notice/i.test(name));
  const required = ['package.json', 'README.md', ...licenses, ...data, 'dist/cli.js', ...modules.map(name => `dist/${name}.js`)];
  const allowed = new Set([...required,
    ...['catalogue', 'git', 'local-workflows', 'stacks', 'vendor.generated'].map(name => `dist/${name}.js`),
    'schemas/catalogue.json', 'schemas/responses.json', 'generated/SKILL.md', 'generated/help.txt', 'generated/capabilities.json']);
  const packed = JSON.parse(run(npm, ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch], root)) as { filename: string }[];
  assert.equal(packed.length, 1);
  const archive = packed[0];
  assert(archive);
  const tarball = join(scratch, archive.filename);
  const files = run('tar', ['-tzf', tarball]).trim().split('\n');
  for (const name of required) assert(files.includes(`package/${name}`), `Missing published file: ${name}`);
  for (const path of files) {
    assert(allowed.has(path.replace(/^package\//, '')), `Unexpected published file: ${path}`);
  }
  const prefix = join(scratch, 'prefix');
  run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--prefix', prefix, tarball]);
  const installed = join(prefix, 'node_modules', '@knowttl', 'gitea-axi');
  const installedPkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as typeof pkg;
  assert.deepEqual([installedPkg.name, installedPkg.version, installedPkg.bin], [pkg.name, pkg.version, pkg.bin]);
  const bin = join(prefix, 'node_modules', '.bin', 'gitea-axi');
  assert.equal(await realpath(bin), join(installed, 'dist/cli.js'));
  assert.match(run(bin, ['--help']), /gitea-axi/);
  assert.equal(run(bin, ['--version']), pkg.version + '\n');
  for (const path of data) JSON.parse(await readFile(join(installed, path), 'utf8'));
  // Resolve and import in a child rooted at the installed consumer, under the outbound deny preload.
  run(process.execPath, ['--input-type=module', '-e',
    `for (const name of ${JSON.stringify(modules)}) await import(import.meta.resolve('@knowttl/gitea-axi/dist/' + name + '.js'));`], prefix);
  console.log('Package contract passed');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
