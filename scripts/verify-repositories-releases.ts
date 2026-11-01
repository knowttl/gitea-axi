import './deny-network.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

type Row = Record<string, unknown>;
interface Output { confirmation: string; error: { code: string; reason: string }; release: Row; notes: { from: string; to: string; commits: Row[] }; observations: { path: string; data: unknown }[]; items: Row[] }
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3]!;
const scratch = await mkdtemp(join(tmpdir(), 'gitea-repositories-releases-'));
const deny = '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url));
const token = 'CANARY-repositories-releases';
const user = { id: 1, login: 'sample' };
const sourceRepo = () => ({ id: 10, full_name: 'sample/demo', name: 'demo', default_branch: 'main', private: false, description: 'Source', owner: user, has_issues: true, has_wiki: true });
const repositories = new Map<string, Row>([['sample/demo', sourceRepo()], ['sample/template', { ...sourceRepo(), id: 11, full_name: 'sample/template', template: true }]]);
const sha = (value: string) => createHash('sha1').update(value).digest('hex');
const ancestor = sha('ancestor'), first = sha('first'), target = sha('target'), side = sha('side');
const commits: Record<string, Row> = {
  [ancestor]: { sha: ancestor, parents: [], commit: { message: 'Excluded ancestor' } },
  [first]: { sha: first, parents: [{ sha: ancestor }], commit: { message: 'First change' } },
  [side]: { sha: side, parents: [{ sha: ancestor }], commit: { message: 'Side change' } },
  [target]: { sha: target, parents: [{ sha: first }, { sha: side }], commit: { message: 'Merge changes' } },
};
const tags = new Map<string, Row>([['v0', { name: 'v0', commit: { sha: ancestor }, message: 'Initial annotation' }], ['existing', { name: 'existing', commit: { sha: target }, message: 'Annotated release notes' }]]);
let releases: Row[] = [{ id: 50, tag_name: 'v0', target_commitish: ancestor, name: 'Initial', body: 'Initial notes', draft: false, prerelease: false, created_at: '2026-01-01T00:00:00Z' }];
let mode = '', effects = 0, origin = '', bin = '', journal = 0;
const tree = [{ path: 'README.md', mode: '100644', type: 'blob', sha: sha('template content') }];
const requests: { method: string; path: string }[] = [];
const assertions: string[] = [];
let host: Awaited<ReturnType<typeof readHost>> | undefined;
let hosted = false;
let fixture: unknown = 'skipped: opt-in frozen Artium fixture required';
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, origin), path = url.pathname;
  const method = request.method!;
  requests.push({ method, path });
  assert.equal(request.headers.authorization, 'token ' + token);
  let bytes = '';
  for await (const chunk of request) bytes += String(chunk);
  const payload = (bytes ? JSON.parse(bytes) : {}) as Row;
  const parts = path.split('/').slice(3).map(decodeURIComponent);
  const full = parts.slice(1, 3).join('/'), repo = repositories.get(full);
  const release = releases.find(row => String(row.id) === parts[4] || parts[4] === 'tags' && row.tag_name === parts[5]);
  let data: unknown, status = 200;
  if (method === 'GET') {
    if (path === '/api/v1/version') data = { version: '1.23.4' };
    else if (path === '/swagger.v1.json') data = { info: { version: '1.23.4' }, paths: { '/version': {} } };
    else if (path === '/api/v1/user') data = user;
    else if (parts[0] === 'orgs') data = { id: 2, name: parts[1], username: parts[1] };
    else if (repo && parts.length === 3) data = repo;
    else if (repo && parts[3] === 'git' && parts[4] === 'trees' && parts[5] === target) data = { sha: sha('tree'), truncated: false, tree: mode === 'transforming' ? [...tree, { path: '.gitea/template', mode: '100644', type: 'blob', sha: sha('README.md') }] : mode === 'wrong-content' && full !== 'sample/template' ? [] : tree };
    else if (repo && parts[3] === 'git' && parts[4] === 'commits') data = commits[parts[5] === 'main' ? target : parts[5]!];
    else if (repo && parts[3] === 'commits') {
      const ref = url.searchParams.get('sha')!;
      data = url.searchParams.get('limit') === '1' ? [commits[['main', 'release/1.x'].includes(ref) ? target : ref]].filter(Boolean) : Object.values(commits);
    }
    else if (repo && parts[3] === 'tags') data = parts.length === 4 ? [...tags.values()] : tags.get(parts[4]!);
    else if (repo && parts[3] === 'releases') data = parts.length === 4 ? releases : release;
  } else if (mode === 'permission') status = 403;
  else {
    effects++;
    if (method === 'POST' && (path === '/api/v1/user/repos' || parts[0] === 'orgs' || parts[3] === 'generate' || parts[3] === 'forks')) {
      const owner = String(payload.owner ?? payload.organization ?? (parts[0] === 'orgs' ? parts[1] : 'sample'));
      const name = String(payload.name ?? repo!.name);
      data = { ...sourceRepo(), id: 100 + effects, name, full_name: owner + '/' + name, ...payload, owner: { id: 20, login: owner } };
      if (parts[3] === 'forks') Object.assign(data as Row, { description: repo!.description, private: repo!.private, fork: true, parent: repo });
      if (mode === 'wrong-field') (data as Row).description = 'Wrong';
      repositories.set(owner + '/' + name, data as Row);
    } else if (repo && method === 'PATCH' && parts.length === 3) {
      Object.assign(repo, payload); if (mode === 'wrong-field') repo.description = 'Wrong'; data = repo;
    } else if (repo && parts[3] === 'releases') {
      if (method === 'POST') {
        data = { id: 100 + effects, created_at: '2026-02-01T00:00:00Z', ...payload };
        if (mode === 'wrong-field') (data as Row).body = 'Wrong';
        releases.push(data as Row);
        if (!tags.has(String(payload.tag_name))) tags.set(String(payload.tag_name), { name: payload.tag_name, commit: { sha: target }, message: '' });
      } else if (method === 'PATCH' && release) { Object.assign(release, payload); if (mode === 'wrong-field') release.body = 'Wrong'; data = release; }
      else if (method === 'DELETE' && release) {
        if (mode !== 'retain-release') releases = releases.filter(row => row !== release);
        if (mode === 'delete-tag') tags.delete(String(release.tag_name));
        data = null; status = 204;
      }
    }
    if (mode === 'disconnect') { request.socket.destroy(); return; }
  }
  if (status === 200 && data === undefined) status = 404;
  response.writeHead(status, { 'content-type': 'application/json' }).end(status === 204 ? undefined : JSON.stringify(data ?? { message: 'Controlled refusal' }));
});
async function run(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env, expected = 0, cwd = root) {
  const child = spawn(executable, args, { cwd, env: { ...env, NODE_OPTIONS: deny }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'close');
  assert.equal(code, expected, args.join(' ') + '\n' + stdout + stderr); assert(!stdout.includes(token)); return stdout;
}
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_STATE_HOME: scratch,
  GITEA_AXI_TOKEN: JSON.stringify({ env: 'SYNTHETIC_TOKEN' }), SYNTHETIC_TOKEN: token, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true' };
async function invoke(args: string[], expected = 0) {
  if (hosted) return await host!.invokeClient(args, expected) as Output;
  return decode(await run(process.execPath, [bin, ...args], { ...env, GITEA_AXI_WRITE_LOG: join(scratch, 'journal-' + journal, 'writes.log') }, expected, scratch)) as unknown as Output;
}
const expect = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); assertions.push(name); };
async function execute(args: string[], grant: string, expected = 0) {
  const argv = [...args.slice(0, 2), '--allow-write', grant];
  const preview = await invoke([...argv, '--preview', ...args.slice(2)]);
  return invoke([...argv, '--confirm', preview.confirmation, ...args.slice(2)], expected);
}
const selected = ['--repo', 'sample/demo'];
let result = 'failed', packageSha256 = '', source: unknown;
try {
  await run('npm', ['run', 'build']);
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string }[];
  packageSha256 = createHash('sha256').update(await readFile(join(scratch, packed!.filename))).digest('hex');
  source = { head: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), dirty: Boolean((await run('git', ['-C', root, 'status', '--porcelain'])).trim()) };
  const prefix = join(scratch, 'installed');
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, join(scratch, packed!.filename)]);
  bin = join(prefix, 'node_modules/@knowttl/gitea-axi/dist/cli.js');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  env.GITEA_AXI_ORIGIN = origin; env.GITEA_AXI_TOKEN_ORIGIN = origin;
  if (task === 'S3.5') {
    for (const [name, flags, grant, destination] of [
      ['Personal', ['personal', '--private'], 'createCurrentUserRepo', 'sample/personal'],
      ['Organization', ['team/project', '--public'], 'createOrgRepo', 'team/project'],
      ['Template', ['generated', '--public', '--template', 'sample/template'], 'generateRepo', 'sample/generated'],
    ] as [string, string[], string, string][]) {
      await execute(['repo', 'create', ...flags, '--description', name], grant);
      const created = repositories.get(destination)!;
      expect(name + ' exact repository identity and fields', [created.full_name, (created.owner as Row).login, created.private, created.description], [destination, destination.split('/')[0], flags.includes('--private'), name]);
    }
    await execute(['repo', 'edit', ...selected, '--description', 'Edited', '--visibility', 'private', '--default-branch', 'main', '--enable-issues=false', '--enable-wiki=false'], 'repoEdit');
    expect('Edit preserves identity and explicit false fields', repositories.get('sample/demo'), { ...sourceRepo(), description: 'Edited', private: true, has_issues: false, has_wiki: false });
    await execute(['repo', 'fork', ...selected, '--org', 'team'], 'createFork');
    expect('Fork parent and destination', [repositories.get('team/demo')!.full_name, (repositories.get('team/demo')!.parent as Row).id], ['team/demo', 10]);
    repositories.get('sample/template')!.default_branch = 'release/1.x';
    await execute(['repo', 'create', 'slash-template', '--public', '--template', 'sample/template'], 'generateRepo');
    expect('Template generation resolves slash-containing default branch', repositories.get('sample/slash-template')!.default_branch, 'release/1.x');
    mode = 'transforming';
    const beforeTransform = effects;
    const transforming = await invoke(['repo', 'create', 'transforming', '--public', '--template', 'sample/template', '--allow-write', 'generateRepo', '--preview'], 1);
    expect('Transforming template refusal is stable and precedes mutation', [transforming.error.code, transforming.error.reason, effects, repositories.has('sample/transforming')], ['CAPABILITY_GAP', 'Transforming templates not yet supported', beforeTransform, false]);
    repositories.get('sample/template')!.default_branch = 'main';
    mode = 'wrong-content';
    expect('Template content mismatch stays uncertain', (await execute(['repo', 'create', 'wrong-content', '--public', '--template', 'sample/template'], 'generateRepo', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = 'wrong-field';
    expect('Wrong repository fields stay uncertain', (await execute(['repo', 'edit', ...selected, '--description', 'Requested'], 'repoEdit', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = '';
    const before = effects;
    for (const flags of [['--internal'], ['--public', '--push'], ['--public', '--source', '.'], ['--public', '--clone']]) {
      await invoke(['repo', 'create', 'refused', ...flags, '--allow-write', 'createCurrentUserRepo', '--preview'], flags.includes('--push') ? 2 : 1);
    }
    expect('Unsupported workspace and internal requests never mutate', effects, before);
    const args = ['repo', 'create', 'bound', '--public', '--description', 'Before', '--allow-write', 'createCurrentUserRepo'];
    const preview = await invoke([...args, '--preview']);
    expect('Confirmation binds repository payload', (await invoke([...args.map(value => value === 'Before' ? 'After' : value), '--confirm', preview.confirmation], 1)).error.code, 'CONFIRMATION_MISMATCH');
  } else {
    const control = structuredClone(releases[0]);
    await execute(['release', 'create', 'v1', ...selected, '--title', 'First', '--notes', 'Exact notes', '--draft', '--prerelease', '--target', 'main'], 'repoCreateRelease');
    expect('Release create exact fields', releases.at(-1), { id: 101, created_at: '2026-02-01T00:00:00Z', tag_name: 'v1', target_commitish: 'main', name: 'First', body: 'Exact notes', draft: true, prerelease: true });
    await execute(['release', 'edit', 'v1', ...selected, '--notes', 'Edited notes', '--draft=false', '--prerelease=false'], 'repoEditRelease');
    const viewed = await invoke(['release', 'view', 'v1', ...selected]);
    expect('View and edit preserve explicit false values', [viewed.release.tag_name, viewed.release.body, viewed.release.draft, viewed.release.prerelease], ['v1', 'Edited notes', false, false]);
    expect('Nonempty compact release list', (await invoke(['release', 'list', ...selected])).items.map(row => row.tag_name), ['v0', 'v1']);
    const tagBefore = structuredClone(tags.get('v1'));
    await execute(['release', 'delete', 'v1', ...selected], 'repoDeleteRelease');
    expect('Release absence is separate from retained tag', [releases.some(row => row.tag_name === 'v1'), tags.get('v1')], [false, tagBefore]);
    const notes = await execute(['release', 'create', 'v2', ...selected, '--generate-notes', '--notes-start-tag', 'v0', '--target', target], 'repoCreateRelease');
    expect('Composite notes carry exact graph boundaries', [notes.notes.from, notes.notes.to, notes.notes.commits.map(row => row.sha).sort()], [ancestor, target, [first, side, target].sort()]);
    expect('Generated notes exclude boundary ancestors', releases.at(-1)!.body, '- Merge changes (' + target + ')\n- Side change (' + side + ')\n- First change (' + first + ')');
    await execute(['release', 'create', 'existing', ...selected, '--verify-tag', '--notes-from-tag'], 'repoCreateRelease');
    expect('Notes from existing annotated tag', releases.at(-1)!.body, 'Annotated release notes');
    tags.set('release/v0', { name: 'release/v0', commit: { sha: ancestor }, message: 'Slash annotation' });
    const slashNotes = await execute(['release', 'create', 'release/v3', ...selected, '--generate-notes', '--notes-start-tag', 'release/v0', '--target', 'release/1.x'], 'repoCreateRelease');
    expect('Slash refs retain exact notes boundaries', [slashNotes.notes.from, slashNotes.notes.to], [ancestor, target]);
    await execute(['release', 'edit', 'release/v3', ...selected, '--notes', '--draft=false', '--draft'], 'repoEditRelease');
    const slashRelease = await invoke(['release', 'view', 'release/v3', ...selected]);
    expect('Flag-like notes preserve explicit draft intent', [slashRelease.release.body, slashRelease.release.draft], ['--draft=false', true]);
    await execute(['release', 'delete', 'release/v3', ...selected], 'repoDeleteRelease');
    expect('Slash release deletion preserves its tag', [releases.some(row => row.tag_name === 'release/v3'), tags.has('release/v3')], [false, true]);
    await execute(['release', 'create', ...selected, '--draft', '--', '--draft=false'], 'repoCreateRelease');
    expect('Boolean-like positional after delimiter stays a tag', [releases.at(-1)!.tag_name, releases.at(-1)!.draft], ['--draft=false', true]);
    await execute(['release', 'edit', 'existing', ...selected, '--notes=--prerelease=false', '--prerelease'], 'repoEditRelease');
    expect('Inline flag-like notes stay data', [releases.find(row => row.tag_name === 'existing')!.body, releases.find(row => row.tag_name === 'existing')!.prerelease], ['--prerelease=false', true]);
    const notesFile = join(scratch, 'cluster-notes.txt');
    await writeFile(notesFile, 'Cluster file notes', { mode: 0o600 });
    for (const [name, clustered, separate, expected] of [
      ['draft-notes', ['-dn', 'Notes'], ['-d', '-n', 'Notes'], { body: 'Notes', draft: true, prerelease: false }],
      ['prerelease-notes', ['-pn', 'Notes'], ['-p', '-n', 'Notes'], { body: 'Notes', draft: false, prerelease: true }],
      ['both-notes', ['-dpn', '--draft=false'], ['-d', '-p', '-n', '--draft=false'], { body: '--draft=false', draft: true, prerelease: true }],
      ['draft-title', ['-dt', 'Title'], ['-d', '-t', 'Title'], { name: 'Title', draft: true, prerelease: false }],
      ['prerelease-title', ['-pt', 'Title'], ['-p', '-t', 'Title'], { name: 'Title', draft: false, prerelease: true }],
      ['both-title', ['-pdt', 'Title'], ['-p', '-d', '-t', 'Title'], { name: 'Title', draft: true, prerelease: true }],
      ['draft-file', ['-dF', notesFile], ['-d', '-F', notesFile], { body: 'Cluster file notes', draft: true, prerelease: false }],
      ['prerelease-file', ['-pF', notesFile], ['-p', '-F', notesFile], { body: 'Cluster file notes', draft: false, prerelease: true }],
      ['both-file', ['-pdF', notesFile], ['-p', '-d', '-F', notesFile], { body: 'Cluster file notes', draft: true, prerelease: true }],
      ['attached-notes', ['-dpnNotes'], ['-d', '-p', '-nNotes'], { body: 'Notes', draft: true, prerelease: true }],
      ['attached-title', ['-dptTitle'], ['-d', '-p', '-tTitle'], { name: 'Title', draft: true, prerelease: true }],
      ['attached-file', ['-dpF' + notesFile], ['-d', '-p', '-F' + notesFile], { body: 'Cluster file notes', draft: true, prerelease: true }],
    ] as [string, string[], string[], Row][]) {
      const actual: Row[] = [];
      for (const [form, flags] of [['clustered', clustered], ['separate', separate]] as const) {
        await execute(['release', 'create', 'cluster-' + name + '-' + form, ...selected, ...flags], 'repoCreateRelease');
        const release = (await invoke(['release', 'view', 'cluster-' + name + '-' + form, ...selected])).release;
        actual.push(Object.fromEntries(Object.keys(expected).map(field => [field, release[field]])));
      }
      expect('Clustered and separate flags preserve ' + name, actual, [expected, expected]);
    }
    for (const failure of ['wrong-field', 'retain-release', 'delete-tag']) {
      journal++; mode = failure;
      const args = failure === 'wrong-field' ? ['release', 'edit', 'existing', ...selected, '--notes', 'Requested notes'] : ['release', 'delete', 'existing', ...selected];
      expect(failure + ' cannot report verified success', (await execute(args, failure === 'wrong-field' ? 'repoEditRelease' : 'repoDeleteRelease', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    }
    mode = ''; journal++;
    const before = effects;
    for (const flags of [['--latest=false'], ['--discussion-category', 'news'], ['--verify-tag'], ['--generate-notes', '--notes-start-tag', 'v2', '--target', ancestor]]) {
      await invoke(['release', 'create', 'refused', ...selected, ...flags, '--allow-write', 'repoCreateRelease', '--preview'], flags.includes('--notes-start-tag') || flags.includes('--verify-tag') ? 2 : 1);
    }
    await invoke(['release', 'create', 'refused', 'asset.zip', ...selected, '--allow-write', 'repoCreateRelease', '--preview'], 2);
    expect('Unsupported flags, missing tags and assets never create releases', effects, before);
    mode = 'disconnect';
    const args = ['release', 'create', 'uncertain', ...selected, '--notes', 'Uncertain notes', '--allow-write', 'repoCreateRelease'];
    const preview = await invoke([...args, '--preview']);
    expect('Applied release then disconnect is uncertain', (await invoke([...args, '--confirm', preview.confirmation], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = '';
    await invoke([...args, '--confirm', preview.confirmation], 1);
    expect('Uncertain release is never duplicated', releases.filter(row => row.tag_name === 'uncertain').length, 1);
    expect('Unrelated release unchanged', releases[0], control);
  }
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(String(bytes)) as { fixtureCommit: string };
    fixture = { revision: manifest.fixtureCommit, manifestSha256: createHash('sha256').update(bytes).digest('hex'), testedHostHead: (await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'rev-parse', 'HEAD'])).trim() };
    mode = ''; repositories.set('sample/demo', sourceRepo());
    process.env.NODE_OPTIONS = deny;
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token });
    hosted = true;
    if (task === 'S3.5') {
      await host.grantWrites(['createCurrentUserRepo', 'createOrgRepo', 'repoEdit', 'createFork', 'generateRepo']);
      await execute(['repo', 'create', 'hosted', '--private', '--description', 'Hosted'], 'createCurrentUserRepo');
      await execute(['repo', 'create', 'team/hosted', '--public'], 'createOrgRepo');
      await execute(['repo', 'create', 'hosted-template', '--public', '--template', 'sample/template'], 'generateRepo');
      await execute(['repo', 'edit', ...selected, '--description', 'Hosted edit', '--enable-issues=false'], 'repoEdit');
      repositories.delete('team/demo');
      await execute(['repo', 'fork', ...selected, '--org', 'team'], 'createFork');
      expect('Hosted repository lifecycle exact destination', [repositories.get('sample/hosted')!.private, repositories.get('sample/demo')!.description, (repositories.get('team/demo')!.parent as Row).id], [true, 'Hosted edit', 10]);
      await host.refuse(['repo', 'create', 'unsafe', '--public', '--source', '.', '--preview', '--allow-write', 'createCurrentUserRepo'], 'FLAG_BLOCKED');
    } else {
      await host.grantWrites(['repoCreateRelease', 'repoEditRelease', 'repoDeleteRelease']);
      await execute(['release', 'create', 'hosted', ...selected, '--draft', '--generate-notes', '--notes-start-tag', 'v0', '--target', target], 'repoCreateRelease');
      await execute(['release', 'edit', 'hosted', ...selected, '--draft=false', '--prerelease=false', '--notes', 'Hosted notes'], 'repoEditRelease');
      expect('Hosted release view', (await invoke(['release', 'view', 'hosted', ...selected])).release.body, 'Hosted notes');
      await invoke(['release', 'list', ...selected]);
      await execute(['release', 'delete', 'hosted', ...selected], 'repoDeleteRelease');
      expect('Hosted deletion preserves tag', [releases.some(row => row.tag_name === 'hosted'), tags.has('hosted')], [false, true]);
    }
  }
  result = 'passed';
} finally {
  if (host) await host.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const report = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(report, JSON.stringify({ task, result, source, packageSha256, fixture, assertions, requests, live: 'pending commissioning', nativeWindows: 'pending' }, null, 2));
  console.log(task + ' ' + result + '; Artium: ' + (host ? result : fixture) + '; report: ' + report);
  await rm(scratch, { recursive: true, force: true });
}
