import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { decode } from '@toon-format/toon';
import { pathToFileURL } from 'node:url';

export async function readHost({ host, bin, scratch, origin, token, artifactFixture = false }) {
  let entry = bin;
  if (process.env.NODE_OPTIONS) {
    entry = join(scratch, 'network-entry.ts');
    await writeFile(entry, `import ${JSON.stringify(new URL('deny-network.ts', import.meta.url).href)};\nprocess.argv[1]=${JSON.stringify(bin)};\nawait import(${JSON.stringify(pathToFileURL(bin).href)});\n`);
  }
  const bootstrap = join(scratch, 'bootstrap');
  const password = 'CANARY-S2-bootstrap';
  const replacement = 'CANARY-S2-replacement';
  await writeFile(bootstrap, password, { mode: 0o600 });
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const launcher = `const {serverDefaults,toolPaths,toolCredentialSchemaPaths}=await import('./dist/src/server/config.js');
    serverDefaults.host='127.0.0.1';serverDefaults.port=Number(process.env.TEST_PORT);serverDefaults.temporaryDirectory=process.env.TEST_SCRATCH+'/calls';
    if(process.env.TEST_ARTIFACT_FIXTURE==='true') {
      const {mkdir}=await import('node:fs/promises');
      const {ArtifactStore,artifactDefaults}=await import('./dist/src/server/artifacts.js');
      const {transferLimits}=await import('./dist/src/shared/api.js');
      const root=process.env.TEST_SCRATCH+'/artifacts'; await mkdir(root,{mode:0o700});
      const create=ArtifactStore.create.bind(ArtifactStore);
      ArtifactStore.create=audit=>create(audit,root,{inspect:async()=>({
        mountinfo:'1 2 0:1 / '+root+' rw,nosuid,nodev,noexec - tmpfs tmpfs rw',filesystemType:0x01021994,
        capacityBytes:transferLimits.reservedBytes,freeBytes:transferLimits.reservedBytes,
        memoryMax:artifactDefaults.containerBytes,memoryCurrent:0,swapMax:0,swapCurrent:0})});
    }
    toolPaths['gitea-axi']=process.env.TEST_BIN;toolCredentialSchemaPaths['gitea-axi']=process.env.TEST_SCHEMA;await import('./dist/src/server/main.js');`;
  const server = spawn(process.execPath, ['--input-type=module', '-e', launcher], { cwd: host, stdio: ['ignore', 'pipe', 'pipe'], env: {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_STATE_HOME: scratch,
    ARTIUM_AXI_MASTER_KEY: randomBytes(32).toString('base64'), ARTIUM_AXI_DATABASE_FILE: join(scratch, 'host/artium.db'),
    ARTIUM_AXI_ADMIN_USERNAME: 'fixture-admin', ARTIUM_AXI_ADMIN_PASSWORD_FILE: bootstrap,
    TEST_PORT: String(port), TEST_SCRATCH: scratch, TEST_BIN: entry, TEST_SCHEMA: join(dirname(dirname(bin)), 'axi-credential.schema.json'),
    TEST_ARTIFACT_FIXTURE: String(artifactFixture),
  } });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const consume = chunk => { log += chunk; if (log.split('\n').some(line => { try { return JSON.parse(line).event === 'listening'; } catch { return false; } })) resolve(); };
    server.stdout.on('data', consume); server.stderr.on('data', consume);
    server.once('exit', code => reject(new Error('Fixture exited ' + code + ': ' + log)));
    AbortSignal.timeout(30000).addEventListener('abort', () => reject(new Error('Fixture startup deadline: ' + log)), { once: true });
  });
  const close = async () => {
    if (server.exitCode === null) { const closed = once(server, 'close'); server.kill('SIGTERM'); await closed; }
    await writeFile(join(scratch, 'host.log'), log);
  };
  try {
    await ready;
    const clientEnv = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: scratch, XDG_CONFIG_HOME: join(scratch, 'client'), ARTIUM_AXI_URL: 'http://127.0.0.1:' + port, ARTIUM_AXI_TEST_HTTP: '1' };
    async function client(args, input, expected = 0) {
      const child = spawn(process.execPath, [join(host, 'dist/cli/artium-axi.mjs'), ...args], { cwd: scratch, env: clientEnv, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.stdin.end(input);
      const [code] = await once(child, 'close'); assert.equal(code, expected, stdout + stderr);
      return stdout;
    }
    await client(['login', '--username', 'fixture-admin', '--password-stdin'], password, 1);
    await client(['passwd', '--password-stdin'], replacement);
    await client(['login', '--username', 'fixture-admin', '--password-stdin'], replacement);
    const session = JSON.parse(await readFile(join(scratch, 'client/artium-axi/session.json'), 'utf8'));
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + session.accessToken };
    async function api(path, method = 'GET', body, expectedStatus) {
      const response = await fetch('http://127.0.0.1:' + port + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
      const value = response.status === 204 ? null : await response.json();
      if (expectedStatus === undefined) assert(response.ok, JSON.stringify(value));
      else assert.equal(response.status, expectedStatus, JSON.stringify(value));
      return value;
    }
    headers['x-artium-reauth-ticket'] = (await api('/v1/auth/reauth', 'POST', { password: replacement })).ticket;
    const path = '/v1/admin/tools/gitea-axi';
    const tool = await api(path);
    await api(path + '/credential', 'PUT', { expectedRevision: 0, expectedToolRevision: tool.revision, value: { origin, tokenOrigin: origin, token, allowInsecureHttp: true } });
    const configured = await api(path); await api(path, 'PATCH', { enabled: true, expectedRevision: configured.revision });
    const role = await api('/v1/admin/roles', 'POST', { name: 'synthetic-reader' });
    await api('/v1/admin/roles/' + role.id + '/tools', 'PUT', { tools: ['gitea-axi'], expectedRevision: role.revision });
    const user = (await api('/v1/admin/users')).users.find(user => user.username === 'fixture-admin');
    await api('/v1/admin/users/' + user.id + '/roles', 'PUT', { roleIds: [role.id], expectedRevision: user.revision });
    assert.equal(decode(await client(['gitea-axi', 'repo', 'view', '--repo', 'sample/demo'])).repository.full_name, 'sample/demo');
    return { close, api, download: args => client(['download', ...args, '--password-stdin'], replacement),
      grantWrites: async operations => {
        headers['x-artium-reauth-ticket'] = (await api('/v1/auth/reauth', 'POST', { password: replacement })).ticket;
        const current = await api(path);
        await api(path + '/write-access', 'PATCH', { enabled: operations.length > 0, operations, expectedRevision: current.revision });
      },
      invokeClient: async (args, code = 0, input) => decode(await client(['gitea-axi', ...args], input, code)),
      refuse: async (args, code) => {
      const value = await api('/v1/tools/gitea-axi/run', 'POST', { args }, 400);
      assert.equal(value.error.code, code, JSON.stringify(value));
      return value;
    }, invoke: async (args, code, input) => {
      const value = await api('/v1/tools/gitea-axi/run', 'POST', { args, ...input });
      assert.equal(value.exitCode, code, value.stdout + value.stderr);
      assert(!value.truncated.stdout, 'Hosted result was truncated');
      for (const form of [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)]) assert(!(value.stdout + value.stderr).includes(form));
      return decode(value.stdout);
    } };
  } catch (error) { await close(); throw error; }
}
