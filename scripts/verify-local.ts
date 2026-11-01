import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

type Row = Record<string, unknown>;
interface Output { confirmation: string; results: Row[]; error: { code: string; reason: string }; stack: { branches: string[]; trunk: string; pulls: { branch: string; head: string; state: string; merged: boolean }[] }; current: string; recovery: unknown }
const task = process.argv[3]!;
assert(['S6.1', 'S6.2'].includes(task));
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'gitea-s6-'));
const repositories = join(scratch, 'service');
const source = join(scratch, 'source');
const canary = 'CANARY-S6-local-git-token';
const user = { id: 1, login: 'sample' };
const requests: { method: string; path: string }[] = [];
const assertions: string[] = [];
const repos = new Map<string, Row>();
const pulls = new Map<string, Row[]>();
let origin = '', denied = false, mergeFailure = 0, packageSha256 = '', losePushReply = false, failFetch = false;
let fetchReads = 0;
let fixture: unknown = 'skipped: opt-in frozen Artium fixture required';
let host: Awaited<ReturnType<typeof readHost>> | undefined;
let result = 'failed';
const env = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_STATE_HOME: scratch,
  NODE_OPTIONS: '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url)),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', S6_TOKEN: canary };

async function run(executable: string, args: string[], cwd = scratch, expected = 0, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(executable, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'close') as [number];
  assert.equal(code, expected, [executable, ...args].join(' ') + '\n' + stdout + stderr);
  return stdout.trimEnd();
}
const git = (args: string[], cwd = source) => run('git', args, cwd);
const bare = (name: string) => join(repositories, name + '.git');
const serviceGit = (name: string, args: string[]) => git(['--git-dir=' + bare(name), ...args], scratch);
async function identity(cwd: string) { await git(['config', 'user.name', 'Synthetic User'], cwd); await git(['config', 'user.email', 'synthetic@example.test'], cwd); }
async function tip(name: string, ref: string) { return serviceGit(name, ['rev-parse', ref]); }
async function createRepo(name: string, parent?: string) {
  await mkdir(join(repositories, name.split('/')[0]!), { recursive: true });
  if (parent) await git(['clone', '--bare', bare(parent), bare(name)], scratch);
  else await git(['init', '--bare', '--initial-branch=main', bare(name)], scratch);
  await serviceGit(name, ['config', 'http.receivepack', 'true']);
  const repo: Row = { id: repos.size + 1, full_name: name, default_branch: 'main', owner: user, private: false, description: '',
    fork: Boolean(parent), ...(parent ? { parent: repos.get(parent) } : {}) };
  repos.set(name, repo); pulls.set(name, []);
  return repo;
}
async function makePull(name: string, head: string, base: string, title = head, body = '') {
  const list = pulls.get(name)!;
  const pull: Row = { id: list.length + 1, number: list.length + 1, title, body, state: 'open', user,
    head: { ref: head, sha: await tip(name, head), repo: repos.get(name) },
    base: { ref: base, sha: await tip(name, base), repo: repos.get(name) }, merged: false,
    assignees: [], labels: [], requested_reviewers: [], requested_reviewers_teams: [], milestone: null };
  list.push(pull); return pull;
}
async function mergePull(name: string, pull: Row, payload: Row) {
  const directory = join(scratch, 'merge-' + name.replace('/', '-') + '-' + pull.number);
  await git(['clone', bare(name), directory], scratch); await identity(directory);
  const head = pull.head as { ref: string; sha: string }, base = pull.base as { ref: string };
  assert.equal(payload.head_commit_id, head.sha);
  await git(['checkout', base.ref], directory);
  await git(['merge', '--no-ff', '-m', 'Merge synthetic PR', 'origin/' + head.ref], directory);
  const sha = await git(['rev-parse', 'HEAD'], directory);
  await git(['push', 'origin', base.ref], directory);
  Object.assign(pull, { merged: true, state: 'closed', merge_commit_sha: sha });
}
async function refreshPull(name: string, pull: Row) {
  const head = pull.head as Row, base = pull.base as Row;
  if (await serviceGit(name, ['for-each-ref', '--format=%(objectname)', 'refs/heads/' + head.ref])) head.sha = await tip(name, String(head.ref));
  base.sha = await tip(name, String(base.ref));
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, 'token ' + canary);
    const url = new URL(request.url!, origin);
    requests.push({ method: request.method!, path: url.pathname });
    if (denied) { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'denied ' + canary })); return; }
    if (url.pathname.includes('.git/')) {
      if (failFetch && url.pathname.endsWith('/info/refs') && ++fetchReads === 2) {
        response.writeHead(503).end(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = Buffer.concat(chunks);
      const child = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'synthetic',
        HTTP_CONTENT_ENCODING: String(request.headers['content-encoding'] ?? ''), HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? '') },
      stdio: ['pipe', 'pipe', 'pipe'] });
      const output: Buffer[] = [];
      child.stdout.on('data', bytes => { output.push(Buffer.from(bytes)); });
      let diagnostic = '';
      child.stderr.on('data', bytes => { diagnostic += String(bytes); });
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error; });
      child.stdin.end(body); await once(child, 'close');
      const bytes = Buffer.concat(output), boundary = bytes.indexOf('\r\n\r\n');
      assert(boundary >= 0, diagnostic);
      if (losePushReply && url.pathname.endsWith('/git-receive-pack')) { losePushReply = false; response.destroy(); return; }
      let status = 200;
      for (const line of bytes.subarray(0, boundary).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.slice(0, 3)); else response.setHeader(key, value);
      }
      response.writeHead(status).end(bytes.subarray(boundary + 4)); return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const payload = body ? JSON.parse(body) as Row : {};
    let data: unknown, status = 200;
    const match = /^\/api\/v1\/repos\/([^/]+\/[^/]+)(.*)$/.exec(url.pathname);
    if (url.pathname === '/api/v1/version') data = { version: '1.23.4' };
    else if (url.pathname === '/swagger.v1.json') data = { info: { version: '1.23.4' }, paths: { '/version': {} } };
    else if (url.pathname === '/api/v1/user') data = user;
    else if (url.pathname === '/api/v1/user/repos' && request.method === 'POST') {
      data = await createRepo('sample/' + payload.name); Object.assign(data as Row, payload, { full_name: 'sample/' + payload.name, owner: user }); status = 201;
    } else if (match) {
      const name = match[1]!, route = match[2]!;
      if (!repos.has(name)) status = 404;
      else if (!route) data = repos.get(name);
      else if (route === '/forks' && request.method === 'POST') { data = await createRepo('sample/' + name.split('/')[1], name); status = 201; }
      else if (route === '/commits') data = [{ sha: await tip(name, url.searchParams.get('sha') ?? 'main'), commit: { message: 'synthetic' } }];
      else if (route.startsWith('/git/commits/')) {
        const sha = await tip(name, decodeURIComponent(route.slice(13)));
        const parents = (await serviceGit(name, ['rev-list', '--parents', '-n', '1', sha])).split(' ').slice(1).map(sha => ({ sha }));
        data = { sha, parents, tree: { sha: await tip(name, sha + '^{tree}') }, commit: { message: 'synthetic' } };
      } else if (route.startsWith('/branches/')) {
        const branch = decodeURIComponent(route.slice(10)); data = { name: branch, commit: { id: await tip(name, branch) } };
      } else if (route === '/pulls') {
        if (request.method === 'POST') { data = await makePull(name, String(payload.head), String(payload.base), String(payload.title), String(payload.body ?? '')); status = 201; }
        else { data = pulls.get(name); await Promise.all(pulls.get(name)!.map(pull => refreshPull(name, pull))); }
      } else if (/^\/pulls\/[1-9]\d*(?:\/merge)?$/.test(route)) {
        const number = Number(route.split('/')[2]);
        const pull = pulls.get(name)!.find(pull => pull.number === number)!;
        if (!pull) status = 404;
        else if (route.endsWith('/merge')) {
          if (number === mergeFailure) status = 409;
          else { await mergePull(name, pull, payload); status = 200; data = {}; }
        } else {
          if (request.method === 'PATCH') {
            if (payload.base) pull.base = { ref: payload.base, sha: await tip(name, String(payload.base)), repo: repos.get(name) };
            for (const [key, value] of Object.entries(payload)) if (key !== 'base') pull[key] = value;
          }
          await refreshPull(name, pull); data = pull;
        }
      } else status = 404;
    } else status = 404;
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data ?? {}));
  } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: String(error) })); }
});

try {
  await mkdir(source); await git(['init', '--initial-branch=main']); await identity(source);
  await writeFile(join(source, 'base.txt'), 'base\n'); await git(['add', '.']); await git(['commit', '-m', 'base']);
  await createRepo('sample/demo');
  await git(['push', bare('sample/demo'), 'main']);
  const baseHead = await git(['rev-parse', 'HEAD']);
  for (const name of ['one', 'two', 'three']) {
    await git(['checkout', '-b', name]); await writeFile(join(source, name + '.txt'), name + '\n');
    await git(['add', '.']); await git(['commit', '-m', name]); await git(['push', bare('sample/demo'), name]);
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  await git(['remote', 'add', 'origin', origin + '/sample/demo.git']);
  await git(['remote', 'add', 'selected', origin + '/sample/demo.git']);
  await run('npm', ['run', 'build'], root);
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root)) as { filename: string }[];
  const tarball = join(scratch, packed[0]!.filename);
  packageSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const cache = await run('npm', ['config', 'get', 'cache'], scratch, 0, { HOME: process.env.HOME });
  await run('npm', ['install', '--offline', '--cache', cache, '--prefix', join(scratch, 'prefix'), '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const bin = join(scratch, 'prefix/node_modules/@knowttl/gitea-axi/dist/cli.js');
  const config = join(scratch, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, defaultProfile: 'test', profiles: { test: { origin, tokenOrigin: origin,
    token: { env: 'S6_TOKEN' }, allowInsecureHttp: true } } }), { mode: 0o600 });
  const invoke = async (args: string[], code = 0, workspace = source, extra: NodeJS.ProcessEnv = {}) => {
    const stdout = await run(process.execPath, [bin, ...args, '--workspace', workspace, '--config', config], scratch, code, extra);
    assert(!stdout.includes(canary)); return decode(stdout) as unknown as Output;
  };
  const execute = async (args: string[], operations: string, workspace = source) => {
    const state = async () => existsSync(join(workspace, '.git')) ? {
      status: await git(['status', '--porcelain'], workspace), refs: await git(['show-ref', '--heads'], workspace),
      metadata: existsSync(join(workspace, '.git/gitea-axi/stacks.json')) ? await readFile(join(workspace, '.git/gitea-axi/stacks.json'), 'utf8') : null,
    } : { contents: await run('git', ['-C', source, 'status', '--porcelain']) };
    const mutations = () => requests.filter(request => request.path.startsWith('/api/') && request.method !== 'GET' || request.path.endsWith('/git-receive-pack')).length;
    const before = await state(), mutationCount = mutations();
    const preview = await invoke([...args, '--allow-write', operations, '--preview'], 0, workspace);
    assert.deepEqual(await state(), before, 'Preview leaves work, refs and stack metadata unchanged');
    assert.equal(mutations(), mutationCount, 'Preview dispatches no upstream mutation');
    return invoke([...args, '--allow-write', operations, '--confirm', preview.confirmation], 0, workspace);
  };
  const check = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); assertions.push(name); };
  const isolatedStack = async (label: string) => {
    const name = 'sample/' + label, workspace = join(scratch, label);
    await createRepo(name, 'sample/demo'); await git(['clone', bare(name), workspace], scratch); await identity(workspace);
    await git(['remote', 'set-url', 'origin', origin + '/' + name + '.git'], workspace);
    for (const branch of ['one', 'two', 'three']) await git(['branch', branch, 'origin/' + branch], workspace);
    for (const [head, base] of [['one', 'main'], ['two', 'one'], ['three', 'two']]) await makePull(name, head!, base!);
    await execute(['stack', 'init', 'one', 'two', 'three', '--base', 'main'], 'gitea.local.stack.init', workspace);
    await execute(['stack', 'link', '1', '2', '3', '--base', 'main'], 'gitea.local.stack.link,repoEditPullRequest', workspace);
    return { name, workspace };
  };
  await git(['config', 'extensions.worktreeConfig', 'true']);
  await git(['config', '--worktree', 'url.http://127.0.0.1:1/.pushInsteadOf', origin + '/']);
  const guardedMutations = requests.filter(request => request.method !== 'GET').length;
  const guardedArgs = task === 'S6.1' ? ['repo', 'create', 'unsafe', '--public', '--source', source, '--push'] : ['stack', 'push'];
  check('Worktree transport rewrite refuses before publication', (await invoke([...guardedArgs, '--preview', '--allow-write',
    'createCurrentUserRepo,gitea.local.composite,gitea.local.stack.push'], 1)).error.code, 'UNSAFE_GIT_CONFIG');
  check('Worktree transport rewrite dispatches no mutation', requests.filter(request => request.method !== 'GET').length, guardedMutations);
  await git(['config', '--worktree', '--unset', 'url.http://127.0.0.1:1/.pushInsteadOf']);

  if (task === 'S6.1') {
    const parent = join(scratch, 'clones'); await mkdir(parent);
    await execute(['repo', 'clone', 'sample/demo'], 'gitea.local.clone', parent);
    const clone = join(parent, 'demo'); await identity(clone);
    check('Clone checks out exact default commit', await git(['rev-parse', 'HEAD'], clone), baseHead);
    check('Persisted remote is credential-free', await git(['remote', 'get-url', 'origin'], clone), origin + '/sample/demo.git');
    const pull = await makePull('sample/demo', 'one', 'main');
    await execute(['pr', 'checkout', String(pull.number)], 'gitea.local.checkout', clone);
    check('PR checkout resolves actual head branch without assuming pull refs', await git(['rev-parse', 'HEAD'], clone), (pull.head as Row).sha);
    await writeFile(join(clone, 'one.txt'), 'dirty\n');
    check('Dirty checkout refuses', (await invoke(['pr', 'checkout', '1', '--preview', '--allow-write', 'gitea.local.checkout'], 1, clone)).error.code, 'DIRTY_WORKSPACE');
    check('Dirty work survives', await readFile(join(clone, 'one.txt'), 'utf8'), 'dirty\n');
    await git(['restore', '--', 'one.txt'], clone);
    await git(['config', 'push.followTags', 'true']);
    await git(['tag', '-a', 'unreviewed', '-m', 'Temporary publication canary']);
    await execute(['repo', 'create', 'published', '--public', '--source', source, '--push', '--remote', 'published'], 'createCurrentUserRepo,gitea.local.composite');
    check('Source publication preserves exact history', await tip('sample/published', 'three'), await git(['rev-parse', 'three']));
    check('Source publication excludes ambient annotated tags', await serviceGit('sample/published', ['for-each-ref', '--format=%(refname)']), 'refs/heads/three');
    check('Conflicting remote refuses before repository creation', (await invoke(['repo', 'create', 'conflict', '--public', '--source', source, '--remote', 'published', '--preview', '--allow-write', 'createCurrentUserRepo,gitea.local.composite'], 2)).error.code, 'USAGE');
    check('Conflicting remote creates no repository', repos.has('sample/conflict'), false);
    await createRepo('upstream/forkable'); await git(['push', bare('upstream/forkable'), 'main']);
    await execute(['repo', 'fork', 'upstream/forkable', '--clone'], 'createFork,gitea.local.composite', parent);
    check('Fork retains exact parent identity', (repos.get('sample/forkable')!.parent as Row).id, repos.get('upstream/forkable')!.id);
    check('Fork clone retains source commit', await git(['rev-parse', 'HEAD'], join(parent, 'forkable')), baseHead);
    await mergePull('sample/demo', pull, { head_commit_id: (pull.head as Row).sha });
    await execute(['pr', 'revert', '1'], 'gitea.local.revert', clone);
    const revert = await git(['rev-parse', 'HEAD'], clone);
    check('Revert tree undoes the original merge', await git(['rev-parse', 'HEAD^{tree}'], clone), await git(['rev-parse', baseHead + '^{tree}'], clone));
    await execute(['pr', 'revert', '1'], 'gitea.local.revert,repoCreatePullRequest', clone);
    check('Revert PR publishes the generated commit', (pulls.get('sample/demo')!.at(-1)!.head as Row).sha, revert);
    const requestCount = requests.length;
    check('Credential origin mismatch refuses before Git/API', (await invoke(['repo', 'clone', 'sample/demo', '--origin', 'http://127.0.0.1:1', '--preview', '--allow-write', 'gitea.local.clone'], 1, parent)).error.code, 'AUTH_BINDING_MISMATCH');
    check('Credential mismatch dispatches nothing', requests.length, requestCount);
  } else {
    const detached = await isolatedStack('detached-stack');
    await execute(['pr', 'checkout', '1'], 'gitea.local.checkout', detached.workspace);
    check('PR checkout leaves HEAD detached', await git(['branch', '--show-current'], detached.workspace), '');
    const detachedState = async () => ({
      head: await git(['rev-parse', 'HEAD'], detached.workspace), refs: await git(['show-ref'], detached.workspace),
      status: await git(['status', '--porcelain'], detached.workspace), work: await git(['diff', '--binary', 'HEAD'], detached.workspace),
      index: await git(['diff', '--cached', '--binary'], detached.workspace),
      metadata: await readFile(join(detached.workspace, '.git/gitea-axi/stacks.json'), 'utf8'),
      effects: await Promise.all((await readdir(join(scratch, 'gitea-axi'), { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(async entry => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), 'utf8')])),
    });
    const beforeDetached = await detachedState(), detachedRequests = requests.length;
    for (const args of [
      ['rebase', 'one'], ['init', 'one', '--base', 'main'], ['link', '1', '--base', 'main'], ['add', 'one'],
      ['push'], ['sync'], ['unstack', '--local'], ['merge', '1', '--merge'], ['checkout', 'one'],
      ['up'], ['down'], ['top'], ['bottom'], ['trunk'],
    ]) {
      const refused = await invoke(['stack', ...args, '--preview', '--allow-write', 'gitea.local.stack.rebase'], 2, detached.workspace);
      check('Detached stack command refuses ' + args.join(' '), refused.error.code, 'USAGE');
      check('Detached refusal explains branch prerequisite ' + args[0], refused.error.reason, 'Check out a branch before running stack commands');
    }
    check('Detached stack refusals preserve refs, work, metadata and effect state', await detachedState(), beforeDetached);
    check('Detached stack refusals dispatch no requests', requests.length, detachedRequests);
    check('Detached stack remains viewable', (await invoke(['stack', 'view'], 0, detached.workspace)).stack.branches, ['one', 'two', 'three']);
    await execute(['stack', 'init', 'one', 'two', 'three', '--base', 'main'], 'gitea.local.stack.init');
    const view = await invoke(['stack', 'view']);
    check('Three-branch stack records exact order and trunk', [view.stack.branches, view.stack.trunk], [['one', 'two', 'three'], 'main']);
    const lockPath = join(source, '.git/gitea-axi/lock');
    await writeFile(lockPath, 'another operation', { mode: 0o600 });
    const lockedArgs = ['stack', 'checkout', 'two', '--allow-write', 'gitea.local.stack.checkout'];
    const lockedPreview = await invoke([...lockedArgs, '--preview']);
    check('Concurrent mutation refuses without breaking the lock', (await invoke([...lockedArgs, '--confirm', lockedPreview.confirmation], 1)).error.code, 'STACK_LOCKED');
    check('Concurrent owner lock is preserved', await readFile(lockPath, 'utf8'), 'another operation');
    await rm(lockPath);
    await execute(['stack', 'checkout', 'two'], 'gitea.local.stack.checkout');
    check('A refused lock does not poison later confirmations', await git(['branch', '--show-current']), 'two');
    for (const [action, argument, expected] of [
      ['bottom', '', 'one'], ['up', '2', 'three'], ['down', '1', 'two'], ['top', '', 'three'], ['trunk', '', 'main'], ['checkout', 'two', 'two'],
    ]) {
      await execute(['stack', action!, ...(argument ? [argument] : [])], 'gitea.local.stack.checkout');
      check('Navigation ' + action, await git(['branch', '--show-current']), expected);
    }
    check('Out-of-range navigation refuses', (await invoke(['stack', 'up', '99', '--preview', '--allow-write', 'gitea.local.stack.checkout'], 2)).error.code, 'USAGE');
    await execute(['stack', 'push', '--remote', 'selected'], 'gitea.local.stack.push');
    for (const branch of ['one', 'two', 'three']) check('Selected remote exact branch ' + branch, await tip('sample/demo', branch), await git(['rev-parse', branch]));
    for (const [head, base] of [['one', 'main'], ['two', 'main'], ['three', 'main']]) await makePull('sample/demo', head!, base!);
    await execute(['stack', 'link', '1', '2', '3', '--base', 'main', '--remote', 'selected'], 'gitea.local.stack.link,repoEditPullRequest');
    check('Linked PRs have ordered bases without duplicates', pulls.get('sample/demo')!.map(pull => (pull.base as Row).ref), ['main', 'one', 'two']);
    for (const selector of ['1', origin + '/sample/demo/pulls/2', 'one']) {
      await execute(['stack', 'checkout', selector], 'gitea.local.stack.checkout');
      check('Checkout selector ' + selector, await git(['branch', '--show-current']), selector === '1' || selector === 'one' ? 'one' : 'two');
    }
    const browsers = join(scratch, 'browser-bin'), marker = join(scratch, 'browser-launched');
    await mkdir(browsers);
    const canaryPath = join(browsers, 'browser-canary.ts');
    await writeFile(canaryPath, await readFile(join(root, 'scripts/browser-canary.ts'))); await chmod(canaryPath, 0o700);
    for (const name of ['xdg-open', 'open', 'sensible-browser']) await symlink(canaryPath, join(browsers, name));
    for (const args of [['submit', '--open'], ['link', '1', '--open'], ['rebase', '--preserve-dates'], ['submit']]) {
      const before = requests.length, refs = await git(['show-ref']);
      check('Unsupported option refuses ' + args.join(' '), (await invoke(['stack', ...args, '--preview', '--allow-write', 'gitea.local.stack.submit'], 1, source,
        { PATH: browsers + ':' + env.PATH, BROWSER: canaryPath, GITEA_AXI_BROWSER_CANARY: marker })).error.code, 'CAPABILITY_GAP');
      check('Gap launches no browser ' + args.join(' '), existsSync(marker), false);
      check('Gap dispatches no request ' + args.join(' '), requests.length, before);
      check('Gap changes no refs ' + args.join(' '), await git(['show-ref']), refs);
    }
    check('GH_REPO refuses', (await invoke(['stack', 'view'], 2, source, { GH_REPO: 'sample/demo' })).error.code, 'USAGE');
    check('--repo refuses', (await invoke(['stack', 'view', '--repo', 'sample/demo'], 2)).error.code, 'USAGE');
    const stale = await invoke(['stack', 'checkout', 'three', '--preview', '--allow-write', 'gitea.local.stack.checkout']);
    await git(['branch', 'unrelated']);
    check('Changed workspace invalidates confirmation', (await invoke(['stack', 'checkout', 'three', '--confirm', stale.confirmation, '--allow-write', 'gitea.local.stack.checkout'], 1)).error.code, 'CONFIRMATION_MISMATCH');
    const merged = await isolatedStack('merge-success');
    await execute(['stack', 'merge', 'one', '--merge'], 'gitea.local.stack.merge,repoEditPullRequest,repoMergePullRequest', merged.workspace);
    check('Merge processes all dependencies in order', pulls.get(merged.name)!.map(pull => pull.merged), [true, true, true]);
    check('Merged stack reaches trunk', await serviceGit(merged.name, ['merge-base', 'main', 'three']), await tip(merged.name, 'three'));
    check('Merge retargets descendants to trunk', pulls.get(merged.name)!.map(pull => (pull.base as Row).ref), ['main', 'main', 'main']);
    await execute(['stack', 'sync'], 'gitea.local.stack.sync', merged.workspace);
    check('Sync refreshes recorded PR completion state', (await invoke(['stack', 'view'], 0, merged.workspace)).stack.pulls.map(pull => [pull.state, pull.merged]),
      [['closed', true], ['closed', true], ['closed', true]]);
    await git(['merge', '--ff-only', 'origin/main'], merged.workspace); await git(['branch', 'unowned'], merged.workspace);
    await git(['checkout', 'one'], merged.workspace);
    await execute(['stack', 'sync', '--prune'], 'gitea.local.stack.sync', merged.workspace);
    check('Prune preserves checked-out owned branch', (await invoke(['stack', 'view'], 0, merged.workspace)).stack.branches, ['one']);
    await git(['checkout', 'main'], merged.workspace);
    await execute(['stack', 'sync', '--prune'], 'gitea.local.stack.sync', merged.workspace);
    check('Prune removes only verified completed owned branches', await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], merged.workspace), 'main\nunowned');
    await git(['config', 'push.default', 'current'], merged.workspace);
    const emptyPushRequests = requests.filter(request => request.path.endsWith('/git-receive-pack')).length;
    check('Empty stack refuses implicit publication', (await invoke(['stack', 'push', '--preview', '--allow-write', 'gitea.local.stack.push'], 2, merged.workspace)).error.code, 'USAGE');
    check('Empty stack publishes nothing', requests.filter(request => request.path.endsWith('/git-receive-pack')).length, emptyPushRequests);
    const partial = await isolatedStack('partial-merge');
    pulls.get(partial.name)![0]!.state = 'closed';
    check('Closed unmerged dependency refuses before merging descendants', (await invoke(['stack', 'merge', '2', '--merge', '--preview', '--allow-write',
      'gitea.local.stack.merge,repoEditPullRequest,repoMergePullRequest'], 2, partial.workspace)).error.code, 'USAGE');
    check('Closed dependency merges no PRs', pulls.get(partial.name)!.map(pull => pull.merged), [false, false, false]);
    pulls.get(partial.name)![0]!.state = 'open';
    await execute(['stack', 'merge', '1', '--merge'], 'gitea.local.stack.merge,repoEditPullRequest,repoMergePullRequest', partial.workspace);
    await execute(['stack', 'sync'], 'gitea.local.stack.sync', partial.workspace);
    await execute(['stack', 'merge', '2', '--merge'], 'gitea.local.stack.merge,repoEditPullRequest,repoMergePullRequest', partial.workspace);
    check('Partial merge skips completed predecessor after sync', pulls.get(partial.name)!.map(pull => pull.merged), [true, true, false]);
    await execute(['stack', 'merge', 'one', '--merge'], 'gitea.local.stack.merge,repoEditPullRequest,repoMergePullRequest', partial.workspace);
    check('Whole-stack merge skips completed predecessors', pulls.get(partial.name)!.map(pull => pull.merged), [true, true, true]);
    await git(['fetch', bare(partial.name), 'refs/heads/main:refs/remotes/origin/main'], partial.workspace);
    for (const name of ['one', 'two', 'three']) await git(['branch', '--unset-upstream', name], partial.workspace);
    for (const name of ['one', 'two', 'three']) await serviceGit(partial.name, ['update-ref', '-d', 'refs/heads/' + name]);
    const pruneArgs = ['stack', 'sync', '--prune', '--allow-write', 'gitea.local.stack.sync'];
    const prunePreview = await invoke([...pruneArgs, '--preview'], 0, partial.workspace);
    await invoke([...pruneArgs, '--confirm', prunePreview.confirmation], 1, partial.workspace);
    check('Failed deletion retains ownership and linked PRs', (await invoke(['stack', 'view'], 0, partial.workspace)).stack.branches, ['one', 'two', 'three']);
    await git(['merge', '--ff-only', 'origin/main'], partial.workspace);
    await execute(['stack', 'sync', '--prune'], 'gitea.local.stack.sync', partial.workspace);
    check('Sync resumes and prunes remotely deleted merged heads', (await invoke(['stack', 'view'], 0, partial.workspace)).stack.branches, []);
    const failed = await isolatedStack('merge-failure');
    mergeFailure = 2;
    const mergeArgs = ['stack', 'merge', 'one', '--merge-method', 'merge', '--allow-write', 'gitea.local.stack.merge,repoEditPullRequest,repoMergePullRequest'];
    const mergePreview = await invoke([...mergeArgs, '--preview'], 0, failed.workspace);
    await invoke([...mergeArgs, '--confirm', mergePreview.confirmation], 1, failed.workspace);
    check('Failed merge stops before its dependent', pulls.get(failed.name)!.map(pull => pull.merged), [true, false, false]);
    check('Failed merge retains recovery checkpoint', Boolean((await invoke(['stack', 'view'], 0, failed.workspace)).recovery), true);
    check('Failed merge checkpoint reports verified completed PRs', (await invoke(['stack', 'view'], 0, failed.workspace)).stack.pulls.map(pull => pull.merged), [true, false, false]);
    mergeFailure = 0;
    const interrupted = await isolatedStack('interrupted-push');
    await git(['checkout', 'three'], interrupted.workspace); await writeFile(join(interrupted.workspace, 'interrupted.txt'), 'published\n');
    await git(['add', '.'], interrupted.workspace); await git(['commit', '-m', 'interrupted push'], interrupted.workspace);
    const pushArgs = ['stack', 'push', '--allow-write', 'gitea.local.stack.push'];
    const pushPreview = await invoke([...pushArgs, '--preview'], 0, interrupted.workspace);
    losePushReply = true;
    await invoke([...pushArgs, '--confirm', pushPreview.confirmation], 1, interrupted.workspace);
    check('Interrupted push reached only intended remote', await tip(interrupted.name, 'three'), await git(['rev-parse', 'three'], interrupted.workspace));
    check('Pending push refuses replay', (await invoke([...pushArgs, '--preview'], 1, interrupted.workspace)).error.code, 'STACK_RECOVERY_REQUIRED');
    const receiveCount = requests.filter(request => request.path.endsWith('/git-receive-pack')).length;
    const syncArgs = ['stack', 'sync', '--allow-write', 'gitea.local.stack.sync'];
    const syncPreview = await invoke([...syncArgs, '--preview'], 0, interrupted.workspace);
    failFetch = true;
    await invoke([...syncArgs, '--confirm', syncPreview.confirmation], 1, interrupted.workspace);
    failFetch = false;
    const pendingSync = (await invoke(['stack', 'view'], 0, interrupted.workspace)).recovery as { confirmations: string[] };
    check('Interrupted recovery retains both confirmation IDs', pendingSync.confirmations, [pushPreview.confirmation, syncPreview.confirmation]);
    await execute(['stack', 'sync'], 'gitea.local.stack.sync', interrupted.workspace);
    check('Recovery clears verified pending state', (await invoke(['stack', 'view'], 0, interrupted.workspace)).recovery, null);
    check('Sync refreshes the published PR head', (await invoke(['stack', 'view'], 0, interrupted.workspace)).stack.pulls.find(pull => pull.branch === 'three')!.head,
      await tip(interrupted.name, 'three'));
    check('Recovery never repeats a dispatched push', requests.filter(request => request.path.endsWith('/git-receive-pack')).length, receiveCount);
    const conflict = await isolatedStack('rebase-conflict');
    const originalTips = await git(['show-ref', '--heads'], conflict.workspace);
    await writeFile(join(conflict.workspace, 'one.txt'), 'trunk version\n'); await git(['add', '.'], conflict.workspace);
    await git(['commit', '-m', 'conflicting trunk'], conflict.workspace); await git(['checkout', 'three'], conflict.workspace);
    const rebaseArgs = ['stack', 'rebase', 'one', '--upstack', '--allow-write', 'gitea.local.stack.rebase'];
    let conflictPreview = await invoke([...rebaseArgs, '--preview'], 0, conflict.workspace);
    await invoke([...rebaseArgs, '--confirm', conflictPreview.confirmation], 1, conflict.workspace);
    check('Conflicting rebase retains native conflict state', (await git(['status', '--porcelain'], conflict.workspace)).includes('AA one.txt'), true);
    check('Abort recovery starts with native detached HEAD', await git(['branch', '--show-current'], conflict.workspace), '');
    const abortArgs = ['stack', 'rebase', '--abort', '--allow-write', 'gitea.local.stack.abort'];
    const abortPreview = await invoke([...abortArgs, '--preview'], 0, conflict.workspace);
    const indexLock = join(conflict.workspace, '.git/index.lock');
    await writeFile(indexLock, 'test-owned native index lock');
    check('Abort blocked by native index lock fails explicitly', (await invoke([...abortArgs, '--confirm', abortPreview.confirmation], 1, conflict.workspace)).error.code, 'GIT_FAILED');
    check('Failed abort retains its recovery confirmation', ((await invoke(['stack', 'view'], 0, conflict.workspace)).recovery as { confirmations: string[] }).confirmations,
      [conflictPreview.confirmation, abortPreview.confirmation]);
    await rm(indexLock);
    await execute(['stack', 'rebase', '--abort'], 'gitea.local.stack.abort', conflict.workspace);
    check('Retried abort clears pending recovery', (await invoke(['stack', 'view'], 0, conflict.workspace)).recovery, null);
    check('Abort restores the original branch', await git(['branch', '--show-current'], conflict.workspace), 'three');
    for (const name of ['one', 'two', 'three']) check('Abort restores original tip ' + name,
      await git(['rev-parse', name], conflict.workspace), originalTips.split('\n').find(line => line.endsWith('refs/heads/' + name))!.split(' ')[0]);
    conflictPreview = await invoke([...rebaseArgs, '--preview'], 0, conflict.workspace);
    await invoke([...rebaseArgs, '--confirm', conflictPreview.confirmation], 1, conflict.workspace);
    await writeFile(join(conflict.workspace, 'one.txt'), 'resolved version\n'); await git(['add', 'one.txt'], conflict.workspace);
    check('Continue recovery starts with native detached HEAD', await git(['branch', '--show-current'], conflict.workspace), '');
    await execute(['stack', 'rebase', '--continue'], 'gitea.local.stack.continue', conflict.workspace);
    check('Continue retains the resolved content through the stack', await git(['show', 'three:one.txt'], conflict.workspace), 'resolved version');
    check('Continue clears recovery and restores original branch', [(await invoke(['stack', 'view'], 0, conflict.workspace)).recovery, await git(['branch', '--show-current'], conflict.workspace)], [null, 'three']);
    await git(['checkout', 'main']); await writeFile(join(source, 'trunk.txt'), 'advance\n'); await git(['add', '.']); await git(['commit', '-m', 'advance trunk']);
    await git(['checkout', 'one']);
    await execute(['stack', 'rebase', '--downstack', '--upstack', '--committer-date-is-author-date', '--remote', 'selected'], 'gitea.local.stack.rebase');
    for (const [parent, child] of [['main', 'one'], ['one', 'two'], ['two', 'three']]) check('Rebased ancestry ' + child, await git(['merge-base', parent!, child!]), await git(['rev-parse', parent!]));
    check('Rebase committer date equals author date', await git(['show', '-s', '--format=%cI', 'three']), await git(['show', '-s', '--format=%aI', 'three']));
    await execute(['stack', 'rebase', 'one', '--upstack', '--no-trunk'], 'gitea.local.stack.rebase');
    for (const staging of ['--all', '--update']) {
      const name = staging.slice(2);
      await git(['checkout', 'three']); await git(['checkout', '-b', name]);
      await writeFile(join(source, 'base.txt'), name + '\n'); await writeFile(join(source, 'untracked-' + name), 'untracked\n');
      await execute(['stack', 'add', name, staging, '--message', 'tracked ' + name], 'gitea.local.stack.add');
      check('Tracked staging commits content ' + staging, await git(['show', 'HEAD:base.txt']), name);
      check('Tracked staging preserves untracked files ' + staging, await git(['ls-files', '--others', '--exclude-standard']), 'untracked-' + name);
      await rm(join(source, 'untracked-' + name));
      await execute(['stack', 'unstack', '--local'], 'gitea.local.stack.unstack');
      await execute(['stack', 'init', 'one', 'two', 'three', '--base', 'main'], 'gitea.local.stack.init');
    }
    for (const flags of [['--all'], ['--all', '--update', '--message', 'invalid']]) {
      check('Invalid staging combination refuses ' + flags.join(' '), (await invoke(['stack', 'add', ...flags, '--preview', '--allow-write', 'gitea.local.stack.add'], 2)).error.code, 'USAGE');
    }
    await execute(['stack', 'unstack', '--local'], 'gitea.local.stack.unstack');
    check('Local unstack preserves PR bases', pulls.get('sample/demo')!.map(pull => (pull.base as Row).ref), ['main', 'one', 'two']);
  }
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(bytes.toString()) as { fixtureCommit: string };
    const testedHead = await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'rev-parse', 'HEAD']);
    assert.equal(testedHead, manifest.fixtureCommit);
    fixture = { revision: testedHead, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token: canary });
    const beforeAdmission = requests.length;
    if (task === 'S6.1') {
      for (const args of [['repo', 'clone', 'sample/demo'], ['pr', 'checkout', '1'], ['pr', 'revert', '1']]) await host.refuse(args, 'INVALID_INPUT');
      for (const args of [['repo', 'create', 'new', '--public', '--source', source], ['repo', 'fork', 'sample/demo', '--clone']]) await host.refuse(args, 'FLAG_BLOCKED');
    } else {
      for (const action of ['view', 'init', 'add', 'checkout', 'push', 'submit', 'sync', 'rebase', 'link', 'unstack', 'merge', 'up', 'down', 'top', 'bottom', 'trunk']) await host.refuse(['stack', action], 'INVALID_INPUT');
    }
    check('Hosted refusal precedes every upstream Git/API effect', requests.length, beforeAdmission);
    assertions.push('Frozen Artium refuses local workspace commands/options');
  }
  const journal = await readFile(join(scratch, 'gitea-axi/writes.log'), 'utf8');
  assert(!journal.includes(canary)); assert(!journal.includes('Authorization'));
  assertions.push('Secret-free shared effect journal');
  denied = true;
  const parent = join(scratch, 'denied'); await mkdir(parent);
  check('Permission denied is explicit and secret-free', (await invoke(['repo', 'clone', 'sample/demo', '--preview', '--allow-write', 'gitea.local.clone'], 1, parent)).error.code, 'PERMISSION_DENIED');
  check('Permission denial creates no checkout', existsSync(join(parent, 'demo')), false);
  result = 'passed';
} finally {
  if (host) await host.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const report = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(report, JSON.stringify({ task, result, packageSha256, sourceHead: await run('git', ['-C', root, 'rev-parse', 'HEAD']),
    assertions, requests, artium: fixture, nativeWindows: 'pending', liveCommissioning: 'pending', preserveDates: 'pending upstream semantics' }, null, 2));
  console.log(task + ' ' + result + '; Artium: ' + (host ? result : 'skipped: opt-in frozen fixture required') + '; report: ' + report);
  await rm(scratch, { recursive: true, force: true });
}
