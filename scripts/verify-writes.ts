import './deny-network.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

type Row = Record<string, unknown>;
interface Output { confirmation: string; error: { code: string; reason: string }; states: string[]; observations: { path: string; data: unknown }[]; results: Row[] }
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3];
assert(['S3.1', 'S3.2'].includes(task!), 'Select a non-empty write task');
const scratch = await mkdtemp(join(tmpdir(), 'gitea-writes-'));
const deny = '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url));
const token = 'CANARY-S3-credential';
const base = '/api/v1/repos/sample/demo';
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/S2/reads.json', import.meta.url), 'utf8')) as { issues: Row[]; label: Row; milestone: Row };
const issues: Row[] = [{ ...fixture.issues[0], number: 1, id: 101, title: 'Selected', body: 'Before', state: 'open', labels: [], assignees: [] },
  { ...fixture.issues[0], number: 2, id: 102, title: 'Control', body: 'Untouched', state: 'open', labels: [], assignees: [] }];
const control = structuredClone(issues[1]);
const labels: Row[] = [{ ...fixture.label, id: 10, name: 'existing', color: 'aabbcc' }, { ...fixture.label, id: 11, name: 'keep', color: '112233' }];
const comments: Row[] = [];
const pinned = new Set([2]);
let applied = 0;
let disconnect = false;
let stall = false;
let ignoreWrite = false;
let failComment = false;
let origin = '';
let bin = '';
let packageSha256 = '';
let coverage: unknown;
let source: unknown;
let host: Awaited<ReturnType<typeof readHost>> | undefined;
let artium: unknown = 'skipped: frozen Artium fixture not supplied';
const requests: { method: string; path: string }[] = [];
const assertions: string[] = [];
const invocations: { executable: string; argv: string[]; code: number | null }[] = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, origin).pathname.replace('/repos/sample/other', '/repos/sample/demo');
  const method = request.method!;
  requests.push({ method, path });
  assert(['token ' + token, 'token ROTATED-CANARY'].includes(String(request.headers.authorization)));
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const payload = body ? JSON.parse(body) as Row : {};
  const parts = path.slice(base.length).split('/').filter(Boolean);
  const issue = issues.find(row => String(row.number) === parts[1]);
  let data: unknown;
  let status = 200;
  if (method === 'GET') {
    if (path === '/api/v1/version') data = { version: '1.23.4' };
    else if (path === '/swagger.v1.json') data = { info: { version: '1.23.4' }, paths: { '/version': {} } };
    else if (path === base) data = { id: 10, full_name: 'sample/demo', default_branch: 'main' };
    else if (path === base + '/labels') data = labels;
    else if (path === base + '/milestones') data = [fixture.milestone];
    else if (path === base + '/issues/pinned') data = issues.filter(row => pinned.has(Number(row.number)));
    else if (parts[0] === 'issues' && parts[2] === 'comments') data = comments.filter(row => row.issue === Number(parts[1]));
    else if (parts[0] === 'issues' && parts[2] === 'labels') data = issue?.labels;
    else if (path === base + '/issues') data = issues;
    else if (parts[0] === 'issues') data = issue;
  } else {
    if (failComment && parts[2] === 'comments') { response.writeHead(503, { 'content-type': 'application/json' }).end('{}'); return; }
    applied++;
    if (path === base + '/issues' && method === 'POST') {
      data = { ...fixture.issues[0], id: 200 + applied, number: 200 + applied, title: payload.title, body: payload.body ?? '', state: 'open',
        labels: labels.filter(row => (payload.labels as number[] ?? []).includes(Number(row.id))),
        assignees: (payload.assignees as string[] ?? []).map(login => ({ id: 50, login })), milestone: payload.milestone ? fixture.milestone : null };
      issues.push(data as Row);
    } else if (parts[0] === 'issues' && issue) {
      if (parts[2] === 'comments') {
        data = { id: 500 + applied, body: payload.body, user: { id: 1, login: 'synthetic' }, issue: issue.number };
        comments.push(data as Row);
      } else if (parts[2] === 'labels') {
        const existing = issue.labels as Row[];
        issue.labels = method === 'POST' ? [...new Map([...existing, ...labels.filter(row => (payload.labels as number[]).includes(Number(row.id)))].map(row => [row.id, row])).values()] : existing.filter(row => String(row.id) !== parts[3]);
        data = issue.labels;
      } else if (parts[2] === 'pin') {
        if (method === 'POST') pinned.add(Number(issue.number)); else pinned.delete(Number(issue.number));
        status = 204;
      } else if (method === 'DELETE') { issues.splice(issues.indexOf(issue), 1); status = 204; }
      else {
        if (!ignoreWrite) Object.assign(issue, payload);
        if (payload.assignees) issue.assignees = (payload.assignees as string[]).map(login => ({ id: 50, login }));
        if (payload.milestone) issue.milestone = fixture.milestone;
        data = issue;
      }
    } else if (parts[0] === 'labels') {
      const label = labels.find(row => String(row.id) === parts[1]);
      if (method === 'POST') { data = { id: 600 + applied, ...payload }; labels.push(data as Row); }
      else if (label && method === 'PATCH') { Object.assign(label, payload); data = label; }
      else if (label && method === 'DELETE') { labels.splice(labels.indexOf(label), 1); status = 204; }
    }
    server.emit('effect-applied');
    if (disconnect) { request.socket.destroy(); return; }
    if (stall) return;
  }
  if (status !== 204 && data === undefined) { status = 404; data = { message: 'Missing synthetic record' }; }
  response.writeHead(status, { 'content-type': 'application/json' }).end(status === 204 ? undefined : JSON.stringify(data));
});
const alternate = createServer(server.listeners('request')[0] as RequestListener);
async function run(executable: string, argv: string[], env: NodeJS.ProcessEnv = process.env, expected: number | null = 0, cwd = root, interrupt = false) {
  const child = spawn(executable, argv, { cwd, env: { ...env, NODE_OPTIONS: deny }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const kill = () => { child.kill('SIGTERM'); };
  if (interrupt) server.once('effect-applied', kill);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'close') as [number | null];
  server.off('effect-applied', kill);
  invocations.push({ executable, argv: argv.map(value => value.replaceAll(token, '[REDACTED]')), code });
  assert.equal(code, expected, stdout + stderr);
  return stdout;
}
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_STATE_HOME: scratch,
  GITEA_AXI_TOKEN: JSON.stringify({ env: 'SYNTHETIC_TOKEN' }), SYNTHETIC_TOKEN: token, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true' };
async function invoke(args: string[], code = 0, extra: NodeJS.ProcessEnv = {}) {
  const output = await run(process.execPath, [bin, ...args], { ...env, ...extra }, code, scratch);
  assert(!output.includes(token), 'Credential must never escape output');
  return decode(output) as unknown as Output;
}
const selected = ['--repo', 'sample/demo'];
async function execute(args: string[], operations: string) {
  const argv = [...args, ...selected, '--allow-write', operations];
  const preview = await invoke([...argv, '--preview']);
  const before = applied;
  const output = await invoke([...argv, '--confirm', preview.confirmation]);
  assert(applied > before, 'The confirmed installed command must apply its mutation');
  assert(output.observations.length > 0, 'The installed command must read back its result');
  return output;
}
const expect = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); assertions.push(name); };
let result = 'failed';
try {
  source = { head: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), dirty: Boolean((await run('git', ['-C', root, 'status', '--porcelain'])).trim()) };
  assert.throws(() => new Socket().connect(443, '192.0.2.1'), /Offline test denied outbound connection/);
  await assert.rejects(fetch('http://192.0.2.1'), /fetch failed/);
  await run('npm', ['run', 'build']);
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string }[];
  const tarball = join(scratch, packed[0]!.filename);
  packageSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(scratch, 'prefix'), tarball]);
  bin = join(scratch, 'prefix/node_modules/@knowttl/gitea-axi/dist/cli.js');
  const installed = join(scratch, 'prefix/node_modules/@knowttl/gitea-axi');
  const registry = JSON.parse(await readFile(join(installed, 'generated/routes.json'), 'utf8')) as { path: string; method: string; operation: string; effect: string }[];
  const swagger = JSON.parse(await readFile(join(root, 'evidence/docs/gitea-1.23.4-swagger.json'), 'utf8')) as { paths: Record<string, Record<string, { operationId: string }>> };
  const captured = Object.entries(swagger.paths).flatMap(([path, methods]) => Object.entries(methods).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)).map(([method, entry]) => ({ path: '/api/v1' + path, method: method.toUpperCase(), operation: entry.operationId })));
  expect('Every captured route and method is classified', registry.map(({ path, method, operation }) => ({ path, method, operation })), captured);
  const selectedOperations = ['getVersion', 'specification', 'repoSearch', 'repoGet', 'issueListIssues', 'repoListPullRequests', 'issueListLabels', 'repoListReleases', 'ListActionTasks',
    'deleteRepoSecret', 'deleteRepoVariable', 'issueDelete', 'issueRemoveLabel', 'unpinIssue', 'issueDeleteLabel', 'repoDeletePullReviewRequests', 'repoDeleteReleaseByTag', 'orgGet', 'orgListRepos', 'issueSearchIssues',
    'repoListActionsSecrets', 'getRepoVariablesList', 'getRepoVariable', 'repoGetAllCommits', 'repoGetCombinedStatusByRef', 'repoListStatusesByRef', 'repoGetContentsList', 'repoGetContents', 'issueGetIssue', 'issueGetComments', 'issueGetLabels', 'issueGetIssueReactions', 'issueGetMilestonesList', 'repoGetPullRequest', 'repoDownloadPullDiffOrPatch', 'repoGetPullRequestCommits', 'repoGetPullRequestFiles', 'repoListPullReviews', 'repoGetPullReviewComments', 'repoGetReleaseByTag', 'repoListReleaseAttachments', 'repoGetReleaseAttachment', 'repoGetTag', 'userGetCurrent', 'userCurrentListRepos', 'userGet', 'userListRepos',
    'repoEdit', 'issueEditIssue', 'issueEditLabel', 'repoEditPullRequest', 'repoEditRelease', 'createOrgRepo', 'createRepoVariable', 'createFork', 'issueCreateIssue', 'issueCreateIssueCommentAttachment', 'issueCreateIssueAttachment', 'issueCreateComment', 'issueAddLabel', 'pinIssue', 'issueCreateLabel', 'repoCreatePullRequest', 'repoMergePullRequest', 'repoCreatePullReviewRequests', 'repoCreatePullReview', 'repoUpdatePullRequest', 'repoCreateRelease', 'repoCreateReleaseAttachment', 'generateRepo', 'createCurrentUserRepo', 'updateRepoSecret', 'updateRepoVariable'];
  assert.equal(selectedOperations.length, 73);
  const operations = selectedOperations.map((operation, index) => {
    const route = registry.find(row => row.operation === operation);
    assert(route || operation === 'specification', 'Selected operation must have a classified route: ' + operation);
    return { operation: 'OP-' + String(index + 1).padStart(3, '0'), outcome: 'AC-' + String(index + 1).padStart(3, '0'), vendor: operation, effect: route?.effect ?? 'read', verification: 'effect classification only' };
  });
  coverage = { operations, credentialCases: ['CS-003', 'CS-009', 'CS-010', 'CS-012', 'CS-013'], crossCuttingCases: ['CX-005', 'CX-006'],
    commands: JSON.parse(await readFile(join(installed, 'generated/host-inventory.json'), 'utf8')) as unknown };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  alternate.listen(0, '127.0.0.1'); await once(alternate, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  env.GITEA_AXI_ORIGIN = origin; env.GITEA_AXI_TOKEN_ORIGIN = origin;
  if (task === 'S3.1') {
    const argv = ['issue', 'create', ...selected, '--title', 'Bound request', '--allow-write', 'issueCreateIssue'];
    const preview = await invoke([...argv, '--preview']);
    expect('Preview has no effects', applied, 0);
    for (const [name, args, extra, code] of [
      ['payload', argv.map(value => value === 'Bound request' ? 'Changed' : value), {}, 'CONFIRMATION_MISMATCH'],
      ['target', argv.map(value => value === 'sample/demo' ? 'sample/other' : value), {}, 'CONFIRMATION_MISMATCH'],
      ['operation', ['label', 'create', ...selected, '--name', 'Different operation', '--color', 'aabbcc', '--allow-write', 'issueCreateLabel'], {}, 'CONFIRMATION_MISMATCH'],
      ['origin', argv, { GITEA_AXI_ORIGIN: 'http://127.0.0.1:' + (alternate.address() as AddressInfo).port, GITEA_AXI_TOKEN_ORIGIN: 'http://127.0.0.1:' + (alternate.address() as AddressInfo).port }, 'CONFIRMATION_MISMATCH'],
      ['credential revision', argv, { SYNTHETIC_TOKEN: 'ROTATED-CANARY' }, 'CONFIRMATION_MISMATCH'],
      ['host read-only', argv, { GITEA_AXI_READ_ONLY: 'true' }, 'READ_ONLY'],
      ['host operation grant', argv, { GITEA_AXI_HOST_WRITE_OPERATIONS: 'issueCreateComment' }, 'READ_ONLY'],
    ] as const) {
      // The fake refuses unexpected credentials before any business request is applied.
      const before = applied;
      const output = await invoke([...args, '--confirm', preview.confirmation], 1, extra);
      expect('Binding/policy ' + name, output.error.code, code); expect('No write for ' + name, applied, before);
    }
    issues[1]!.title = 'Changed upstream';
    expect('Precondition binding', (await invoke([...argv, '--confirm', preview.confirmation], 1)).error.code, 'CONFIRMATION_MISMATCH');
    issues[1]!.title = 'Control';
    const before = applied;
    const denyCases = [
      ['api', 'GET', 'repos/sample/demo/actions/runners/registration-token'],
      ['api', 'POST', 'unclassified', '--allow-write', 'anything', '--preview'],
      ['issue', 'create', ...selected, '--title', 'Denied', '--preview'],
    ];
    for (const args of denyCases) expect('Read-only refusal ' + args.join(' '), (await invoke(args, 1)).error.code, 'READ_ONLY');
    expect('Refusals dispatch no effects', applied, before);
    for (const [method, path, payload, operation] of [
      ['POST', 'issues', { title: 'Raw created' }, 'issueCreateIssue'],
      ['PATCH', 'issues/1', { title: 'Raw edited' }, 'issueEditIssue'],
      ['PUT', 'issues/1/labels', { labels: [10] }, 'issueReplaceLabels'],
      ['DELETE', 'issues/2', undefined, 'issueDelete'],
    ] as const) {
      const input = join(scratch, 'request.json');
      if (payload) await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
      const args = ['api', method, 'repos/sample/demo/' + path, '--allow-write', operation, ...(payload ? ['--input', input] : [])];
      const p = await invoke([...args, '--preview']);
      await invoke([...args, '--confirm', p.confirmation]);
      assertions.push('Raw ' + method + ' uses shared confirmation');
    }
    const fieldArgs = ['api', '-X', 'POST', 'repos/sample/demo/issues', '--field', 'title=Typed fields', '--raw-field', 'body=+1', '--field', 'closed=false', '--allow-write', 'issueCreateIssue'];
    const fieldPreview = await invoke([...fieldArgs, '--preview']);
    await invoke([...fieldArgs, '--confirm', fieldPreview.confirmation]);
    expect('Raw repeatable typed and string fields', [issues.at(-1)!.title, issues.at(-1)!.body, issues.at(-1)!.state], ['Typed fields', '+1', 'open']);
    expect('Secret argv field refusal', (await invoke(['api', 'PUT', 'repos/sample/demo/actions/secrets/SYNTHETIC', '--field', 'data=' + token], 1)).error.code, 'CONFIG_INVALID');
    disconnect = true;
    const uncertain = ['issue', 'create', ...selected, '--title', 'Applied once', '--allow-write', 'issueCreateIssue'];
    const p = await invoke([...uncertain, '--preview']);
    const output = await invoke([...uncertain, '--confirm', p.confirmation], 1);
    expect('Applied then connection lost', output.error.code, 'WRITE_OUTCOME_UNKNOWN');
    assert(output.error.reason.includes('gitea-axi write reconcile ' + p.confirmation));
    const count = issues.length;
    await invoke([...uncertain, '--confirm', p.confirmation], 1);
    await invoke([...uncertain, '--preview'], 1);
    expect('Raw API cannot bypass a named uncertain effect', (await invoke(['api', 'POST', 'repos/sample/demo/issues', '--raw-field', 'title=Applied once', '--allow-write', 'issueCreateIssue', '--preview'], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    expect('Unknown create is never repeated', issues.length, count);
    disconnect = false;
    const reconciled = await invoke(['write', 'reconcile', p.confirmation]);
    expect('Exact reconcile command reads applied issue', (reconciled.observations[0]!.data as Row[]).filter(row => row.title === 'Applied once').length, 1);
    const timed = ['issue', 'comment', '1', ...selected, '--body', 'Applied before timeout', '--allow-write', 'issueCreateComment'];
    const timedPreview = await invoke([...timed, '--preview']);
    stall = true;
    expect('Timeout after applied comment', (await invoke([...timed, '--confirm', timedPreview.confirmation], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    stall = false;
    const commentCount = comments.length;
    await invoke([...timed, '--confirm', timedPreview.confirmation], 1);
    expect('Timed out comment is not duplicated', comments.length, commentCount);
    const interrupted = ['issue', 'comment', '1', ...selected, '--body', 'Interrupted comment', '--allow-write', 'issueCreateComment'];
    const interruptPreview = await invoke([...interrupted, '--preview']);
    await run(process.execPath, [bin, ...interrupted, '--confirm', interruptPreview.confirmation], env, null, scratch, true);
    expect('Interruption after application leaves exactly one comment', comments.filter(row => row.body === 'Interrupted comment').length, 1);
    expect('Interrupted comment refuses replay', (await invoke([...interrupted, '--confirm', interruptPreview.confirmation], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
  } else {
    const bodyFile = join(scratch, 'issue-body.txt');
    await writeFile(bodyFile, 'Exact body', { mode: 0o600 });
    await execute(['issue', 'create', '--title', 'Created title', '--body-file', bodyFile, '--assignee', 'synthetic', '--label', 'existing', '--milestone', String(fixture.milestone.title)], 'issueCreateIssue');
    const created = issues.at(-1)!;
    expect('Create exact title/body/assignee/label/milestone', [created.title, created.body, created.assignees, created.labels, created.milestone],
      ['Created title', 'Exact body', [{ id: 50, login: 'synthetic' }], [labels[0]], fixture.milestone]);
    await execute(['issue', 'edit', '1', '--title', 'Edited', '--body', 'Edited body', '--add-assignee', 'synthetic', '--milestone', String(fixture.milestone.title), '--add-label', 'existing', '--add-label', 'keep'], 'issueEditIssue,issueAddLabel');
    expect('Edit exact fields', [issues[0]!.title, issues[0]!.body, issues[0]!.assignees, issues[0]!.milestone], ['Edited', 'Edited body', [{ id: 50, login: 'synthetic' }], fixture.milestone]);
    await execute(['issue', 'edit', '1', '--add-assignee', 'retained', '--add-assignee', 'temporary', '--remove-assignee', 'temporary'], 'issueEditIssue');
    await execute(['issue', 'edit', '1', '--remove-assignee', 'synthetic'], 'issueEditIssue');
    expect('Assignee delta preserves unrelated membership', issues[0]!.assignees, [{ id: 50, login: 'retained' }]);
    await execute(['issue', 'edit', '1', '--remove-label', 'existing'], 'issueRemoveLabel');
    expect('Membership delta preserves unrelated labels', (issues[0]!.labels as Row[]).map(row => row.id), [11]);
    for (const [action, state, grant] of [['close', 'closed', 'issueEditIssue,issueCreateComment'], ['reopen', 'open', 'issueEditIssue']] as const) {
      await execute(['issue', action, '1', ...(action === 'close' ? ['--comment', 'Closed exactly once'] : [])], grant);
      expect(action + ' same issue state', issues[0]!.state, state);
    }
    expect('Close comment exactly once', comments.filter(row => row.body === 'Closed exactly once').length, 1);
    await execute(['issue', 'comment', '1', '--body', 'Standalone comment'], 'issueCreateComment');
    expect('Comment exact body on selected issue', comments.at(-1)!.body, 'Standalone comment');
    for (const [action, grant, expected] of [['pin', 'pinIssue', [2, 1]], ['unpin', 'unpinIssue', [2]]] as const) {
      await execute(['issue', action, '1'], grant); expect(action + ' preserves control pin', [...pinned], expected);
    }
    await execute(['label', 'create', '--name', 'new label', '--color', '#A1B2C3'], 'issueCreateLabel');
    const labelId = labels.at(-1)!.id;
    expect('Normalize label colour', labels.at(-1)!.color, 'a1b2c3');
    await execute(['label', 'edit', 'new label', '--name', 'renamed', '--description', 'Exact description'], 'issueEditLabel');
    expect('Rename preserves label identity', [labels.at(-1)!.id, labels.at(-1)!.name], [labelId, 'renamed']);
    await execute(['label', 'delete', 'renamed'], 'issueDeleteLabel');
    expect('Label deletion with control intact', labels.map(row => row.id), [10, 11]);
    const before = applied;
    for (const [action, flag] of [['create', '--type'], ['edit', '--project'], ['close', '--reason'], ['close', '--duplicate'], ['create', '--attachment']] as const) {
      expect('Unsupported ' + flag, (await invoke(['issue', action, ...(action === 'create' ? [] : ['1']), ...selected, flag, 'unsupported'], 2)).error.code, 'USAGE');
    }
    expect('Unsupported flags dispatch no effects', applied, before);
    expect('Unknown milestone refusal', (await invoke(['issue', 'edit', '1', ...selected, '--milestone', 'absent', '--allow-write', 'issueEditIssue', '--preview'], 2)).error.code, 'USAGE');
    const noEffect = ['issue', 'edit', '1', ...selected, '--title', 'Must be read back', '--allow-write', 'issueEditIssue'];
    const noEffectPreview = await invoke([...noEffect, '--preview']);
    ignoreWrite = true;
    expect('Readback rejects an unapplied field', (await invoke([...noEffect, '--confirm', noEffectPreview.confirmation], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    ignoreWrite = false;
    failComment = true;
    const partial = ['issue', 'close', '1', ...selected, '--comment', 'Failed comment', '--allow-write', 'issueEditIssue,issueCreateComment'];
    const p = await invoke([...partial, '--preview']);
    const output = await invoke([...partial, '--confirm', p.confirmation], 1);
    expect('Partial close reports completed and dispatched steps', output.error.code, 'WRITE_OUTCOME_UNKNOWN');
    assert(output.error.reason.includes('completed,dispatched'));
    expect('Partial close remains closed', issues[0]!.state, 'closed');
    failComment = false;
    await execute(['issue', 'delete', String(created.number)], 'issueDelete');
    expect('Delete intended identity only', issues.map(row => row.number), [1, 2]);
    expect('Unrelated issue unchanged', issues[1], control);
  }
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST, 'Frozen hosted proof requires its manifest');
    const manifestBytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(manifestBytes.toString()) as { fixtureCommit: string };
    artium = { revision: manifest.fixtureCommit, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      testedHostHead: (await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'rev-parse', 'HEAD'])).trim(),
      testedHostDirty: Boolean((await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'status', '--porcelain'])).trim()) };
    process.env.NODE_OPTIONS = deny;
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token });
    const args = ['issue', 'create', ...selected, '--title', 'Hosted exact issue', '--body', 'Hosted exact body', '--allow-write', 'issueCreateIssue'];
    await host.refuse([...args, '--preview'], 'FLAG_BLOCKED');
    await host.grantWrites(['issueCreateIssue']);
    const preview = await host.invokeClient([...args, '--preview']) as Output;
    const before = issues.length;
    await host.invokeClient([...args, '--confirm', preview.confirmation]);
    expect('Real Artium client creates exact issue', [issues.length, issues.at(-1)!.title, issues.at(-1)!.body], [before + 1, 'Hosted exact issue', 'Hosted exact body']);
    await host.refuse(['issue', 'delete', '1', ...selected, '--allow-write', 'issueDelete', '--preview'], 'FLAG_BLOCKED');
    assertions.push('Real Artium host grant refuses an ungranted operation');
  }
  const journal = await readFile(join(scratch, 'gitea-axi/writes.log'), 'utf8');
  const receipts = await readdir(join(scratch, 'gitea-axi/write-receipts'));
  const persisted = journal + (await Promise.all(receipts.map(name => readFile(join(scratch, 'gitea-axi/write-receipts', name), 'utf8')))).join('');
  for (const secret of [token, 'Exact body', 'Standalone comment', 'Failed comment']) assert(!persisted.includes(secret), 'Journal and receipts contain no credential or request body');
  assertions.push('Secret-free durable journal and receipts');
  result = 'passed';
} finally {
  if (host) await host.close();
  if (alternate.listening) await new Promise<void>((resolve, reject) => alternate.close(error => error ? reject(error) : resolve()));
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const reportPath = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(reportPath, JSON.stringify({ task, result, source, packageSha256, coverage, assertions, invocations, requests, artium }, null, 2));
  console.log(task + ' ' + result + '; Artium: ' + (host ? 'verified' : 'skipped: frozen fixture not supplied') + '; report: ' + reportPath);
  await rm(scratch, { recursive: true, force: true });
}
