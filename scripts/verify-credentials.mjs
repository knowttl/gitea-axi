import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(root, '.credential-check-'));
const canary = 'CANARY-injected-"/%-token';
const forms = [canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary)];
const command = ['repo', 'view', '--repo', 'sample-owner/sample-repo'];
const routes = {
  '/api/v1/version': JSON.parse(await readFile(new URL('../evidence/fixtures/P-001.json', import.meta.url))),
  '/swagger.v1.json': JSON.parse(await readFile(new URL('../evidence/fixtures/P-002.json', import.meta.url))),
  '/api/v1/repos/sample-owner/sample-repo': JSON.parse(await readFile(new URL('../evidence/fixtures/P-004.json', import.meta.url))),
};
let echo = false;
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  assert.equal(request.headers.authorization, 'token ' + canary);
  let body = routes[request.url];
  if (echo && request.url === '/api/v1/version') body = { version: forms.join('|') };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const env = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: scratch, APPDATA: scratch, XDG_CONFIG_HOME: scratch,
    GITEA_AXI_ORIGIN: origin, GITEA_AXI_TOKEN_ORIGIN: origin,
    GITEA_AXI_TOKEN: JSON.stringify({ env: 'TEST_TOKEN' }), TEST_TOKEN: canary, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true',
  };
  async function invoke(extra = {}, code = 0, program) {
    const argv = program ? ['--input-type=module', '-e', program] : ['dist/cli.js', ...command];
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [actual] = await once(child, 'close');
    assert.equal(actual, code, stdout + stderr);
    assert.equal(stderr, '');
    return decode(stdout);
  }
  assert.deepEqual((await invoke()).repository, { id: 1008, full_name: 'sample-owner/sample-repo', default_branch: 'main' });
  echo = true;
  assert.equal((await invoke()).server.version, '[REDACTED]|[REDACTED]|[REDACTED]');
  const failure = await invoke({}, 2, `
    import { credentials } from './dist/credentials.js';
    import { main } from './dist/main.js';
    await credentials(undefined, false);
    await main(${JSON.stringify([...command, '--unknown=' + forms.join('|')])});
  `);
  assert.equal(failure.error.code, 'USAGE');
  for (const form of forms) assert(!failure.error.reason.includes(form));
  echo = false;
  for (const value of ['1', '0', 'TRUE', 'False', 'true\n']) {
    assert.equal((await invoke({ GITEA_AXI_ALLOW_INSECURE_HTTP: value }, 1)).error.code, 'CONFIG_INVALID');
  }
  assert.equal((await invoke({ GITEA_AXI_ALLOW_INSECURE_HTTP: 'false' }, 1)).error.code, 'CONFIG_INVALID');
  const secure = 'https://gitea.example.test';
  assert.equal((await invoke({ GITEA_AXI_ORIGIN: secure, GITEA_AXI_TOKEN_ORIGIN: secure, GITEA_AXI_ALLOW_INSECURE_HTTP: 'false' }, 0, `
    import { credentials } from './dist/credentials.js';
    import { encode } from '@toon-format/toon';
    console.log(encode({ origin: (await credentials(undefined, false)).origin }));
  `)).origin, secure);
  const config = join(scratch, 'config.json');
  const profile = { origin, tokenOrigin: origin, token: { env: 'TEST_TOKEN' }, allowInsecureHttp: true };
  const selected = { GITEA_AXI_CONFIG: config, GITEA_AXI_PROFILE: 'test' };
  await writeFile(config, JSON.stringify({ version: 1, profiles: { test: profile } }), { mode: 0o600 });
  assert.equal((await invoke(selected)).repository.id, 1008);
  await writeFile(config, JSON.stringify({ version: 1, profiles: { test: { ...profile, writes: { allowWrites: false, operations: [] } } } }));
  assert.equal((await invoke(selected)).repository.id, 1008);
  const token = join(scratch, 'token');
  await writeFile(token, canary + '\n', { mode: 0o600 });
  const fileRef = { GITEA_AXI_TOKEN: JSON.stringify({ file: token }) };
  if (process.platform !== 'win32') {
    assert.equal((await invoke(fileRef)).repository.id, 1008);
    await chmod(token, 0o644);
    assert.equal((await invoke(fileRef, 1)).error.code, 'CONFIG_INSECURE');
  }
  const windows = `Object.defineProperty(process, 'platform', { value: 'win32' });
    const { main } = await import('./dist/main.js'); await main(${JSON.stringify(command)});`;
  assert.equal((await invoke({}, 0, windows)).repository.id, 1008);
  const before = requests;
  const refused = await invoke(fileRef, 1, windows);
  assert.equal(refused.error.code, 'CONFIG_INVALID');
  assert.match(refused.error.reason, /Windows; use env SecretRefs/);
  await writeFile(config, JSON.stringify({ version: 1, profiles: { test: { ...profile, token: { file: token } } } }));
  assert.equal((await invoke(selected, 1, windows)).error.code, 'CONFIG_INVALID');
  assert.equal(requests, before);
  console.log('Credential regression checks passed');
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(scratch, { recursive: true, force: true });
}
