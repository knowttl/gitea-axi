import './deny-network.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { readHost } from './read-host.mjs';

type Row = Record<string, unknown>;
interface Output { confirmation: string; error: { code: string; reason: string }; observations: { path: string; data: unknown }[] }
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[3]!;
assert(['S3.3', 'S3.4'].includes(task));
const scratch = await mkdtemp(join(tmpdir(), 'gitea-pulls-'));
const deny = '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url));
const token = 'CANARY-PR-credential';
const base = '/api/v1/repos/sample/demo';
const sha = (value: string) => createHash('sha1').update(value).digest('hex');
const baseSHA = sha('base'), headSHA = sha('head'), oldSHA = sha('common');
const firstSHA = sha('feature-first'), rebasedFirstSHA = sha('rebased-first');
const user = { id: 1, login: 'synthetic' };
// Synthetic wire fixtures follow the retained Gitea 1.23.4 schemas.
const seed = () => ({ id: 101, number: 1, title: 'Selected', body: 'Before', state: 'open', merged: false, user,
  head: { ref: 'feature', sha: headSHA }, base: { ref: 'main', sha: baseSHA },
  assignees: [user], labels: [{ id: 10, name: 'keep', color: 'aabbcc' }], milestone: null,
  requested_reviewers: [{ id: 2, login: 'retained' }], requested_reviewers_teams: [{ id: 3, name: 'retained-team' }] });
let pulls: Row[] = [seed(), { ...seed(), id: 102, number: 2, title: 'Control' }];
let comments: Row[] = [];
const labels = [{ id: 10, name: 'keep', color: 'aabbcc' }, { id: 11, name: 'added', color: '112233' }];
const milestone = { id: 20, title: 'Release', state: 'open' };
const branches = new Map<string, string>();
const commits = new Map<string, Row>();
let scenario = 0;
const addCommit = (id: string, parents: string[], message: string) => commits.set(id, { sha: id, parents: parents.map(sha => ({ sha })), commit: { message } });
function reset() {
  scenario++;
  pulls = [seed(), { ...seed(), id: 102, number: 2, title: 'Control' }]; comments = [];
  branches.set('main', baseSHA); branches.set('feature', headSHA);
  commits.clear(); addCommit(oldSHA, [], 'common'); addCommit(baseSHA, [oldSHA], 'base'); addCommit(firstSHA, [oldSHA], 'first'); addCommit(headSHA, [firstSHA], 'feature');
}
reset();
let mode = '', effects = 0, origin = '', bin = '', packageSha256 = '';
let host: Awaited<ReturnType<typeof readHost>> | undefined;
let artium: unknown = 'skipped: opt-in frozen fixture required';
const requests: { method: string; path: string }[] = [];
const assertions: string[] = [];
const invocations: { args: string[]; code: number | null }[] = [];
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url!, origin).pathname);
  const method = request.method!;
  requests.push({ method, path });
  assert.equal(request.headers.authorization, 'token ' + token);
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const payload = (body ? JSON.parse(body) : {}) as Row;
  const parts = path.slice(base.length).split('/').filter(Boolean);
  const pull = pulls.find(row => String(row.number) === parts[1]);
  let data: unknown, status = 200;
  if (method === 'GET') {
    if (path === '/api/v1/version') data = { version: '1.23.4' };
    else if (path === '/swagger.v1.json') data = { info: { version: '1.23.4' }, paths: { '/version': {} } };
    else if (path === '/api/v1/user') data = user;
    else if (path.startsWith('/api/v1/users/')) data = [user, { id: 2, login: 'retained' }, { id: 4, login: 'new' }].find(row => row.login === path.slice('/api/v1/users/'.length));
    else if (path === base) data = { id: 10, full_name: 'sample/demo', default_branch: 'main' };
    else if (parts[0] === 'branches') data = { name: parts[1], commit: { id: branches.get(parts[1]!) } };
    else if (parts[0] === 'git' && parts[1] === 'commits') data = commits.get(parts[2]!);
    else if (parts[0] === 'labels') data = labels;
    else if (parts[0] === 'milestones') data = [milestone];
    else if (parts[0] === 'assignees') data = [user, { id: 2, login: 'retained' }, { id: 4, login: 'new' }];
    else if (parts[0] === 'reviewers') status = 403;
    else if (parts[0] === 'teams') data = [{ id: 3, name: 'retained-team' }, { id: 5, name: 'new-team' }];
    else if (parts[0] === 'issues' && parts[2] === 'comments') data = comments.filter(row => row.issue === Number(parts[1]));
    else if (parts[0] === 'pulls' && parts[2] === 'commits') data = [commits.get(firstSHA), commits.get(headSHA)];
    else if (parts[0] === 'pulls') data = parts.length === 1 ? pulls : pull;
  } else {
    if (mode === 'fail-comment' && parts[2] === 'comments') status = 503;
    else if (mode === 'reject-reviewer' && parts[2] === 'requested_reviewers') status = 422;
    else if (mode === 'conflict' && parts[2] === 'update') status = 409;
    else if (parts[2] === 'merge' && (mode === 'race' || payload.head_commit_id !== (pull!.head as Row).sha)) {
      // The controlled service moves head after the client's preflight, then applies the vendor precondition.
      if (mode === 'race') (pull!.head as Row).sha = sha('racing-head');
      status = 409;
    } else {
      effects++;
      if (parts[0] === 'pulls' && parts.length === 1) {
        const created = { ...seed(), id: 200 + effects, number: 200 + effects, ...payload,
          head: { ref: payload.head, sha: branches.get(String(payload.head)) }, base: { ref: payload.base, sha: branches.get(String(payload.base)) },
          assignees: (payload.assignees as string[] ?? []).map((login, id) => ({ id, login })),
          labels: labels.filter(row => (payload.labels as number[] ?? []).includes(row.id)), milestone: payload.milestone ? milestone : null,
          requested_reviewers: (payload.reviewers as string[] ?? []).map((login, id) => ({ id, login })),
          requested_reviewers_teams: (payload.team_reviewers as string[] ?? []).map((name, id) => ({ id, name })) };
        pulls.push(created); data = created;
      } else if (parts[0] === 'issues' && parts[2] === 'comments') {
        data = { id: 500 + effects, body: payload.body, user, issue: Number(parts[1]) }; comments.push(data as Row);
      } else if (pull && parts[2] === 'requested_reviewers') {
        for (const [wire, field, key] of [['reviewers', 'requested_reviewers', 'login'], ['team_reviewers', 'requested_reviewers_teams', 'name']] as const) {
          const previous = pull[field] as Row[], selected = payload[wire] as string[] ?? [];
          pull[field] = method === 'POST' ? [...previous, ...selected.map((name, id) => ({ id: 20 + id, [key]: name }))] : previous.filter(row => !selected.includes(String(row[key])));
        }
        data = [];
      } else if (pull && parts[2] === 'update') {
        const next = sha('updated-' + effects);
        addCommit(next, mode === 'wrong-graph' ? [headSHA] : [headSHA, baseSHA], 'update');
        (pull.head as Row).sha = next; branches.set('feature', next); data = null;
      } else if (pull && parts[2] === 'merge') {
        const next = sha(String(payload.Do) + effects);
        if (payload.Do === 'rebase') addCommit(rebasedFirstSHA, [branches.get('main')!], 'first');
        const parents = payload.Do === 'merge' ? [branches.get('main')!, String((pull.head as Row).sha)] : payload.Do === 'rebase' ? [rebasedFirstSHA] : [branches.get('main')!];
        addCommit(next, mode === 'wrong-graph' ? [oldSHA] : parents, payload.Do === 'rebase' ? 'feature' : 'merged');
        branches.set('main', next); Object.assign(pull, { state: 'closed', merged: true, merge_commit_sha: next }); data = null;
      } else if (pull && method === 'PATCH') {
        const { base: nextBase, assignees, labels: nextLabels, milestone: nextMilestone, ...fields } = payload;
        Object.assign(pull, fields);
        if (nextBase) pull.base = { ref: nextBase, sha: branches.get(String(nextBase)) };
        if (assignees) pull.assignees = (assignees as string[]).map((login, id) => ({ id, login }));
        if (nextLabels) pull.labels = labels.filter(row => (nextLabels as number[]).includes(row.id));
        if (nextMilestone) pull.milestone = milestone;
        if (mode === 'wrong-field') pull.title = 'Unexpected';
        data = pull;
      }
      if (mode === 'disconnect') { request.socket.destroy(); return; }
    }
  }
  if (status !== 200) data = { message: 'Controlled refusal' };
  else if (data === undefined) { status = 404; data = { message: 'Missing synthetic record' }; }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
});
async function run(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env, expected = 0, cwd = root) {
  const child = spawn(executable, args, { cwd, env: { ...env, NODE_OPTIONS: deny }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'close') as [number | null];
  invocations.push({ args, code }); assert.equal(code, expected, stdout + stderr); return stdout;
}
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_STATE_HOME: scratch,
  GITEA_AXI_TOKEN: JSON.stringify({ env: 'SYNTHETIC_TOKEN' }), SYNTHETIC_TOKEN: token, GITEA_AXI_ALLOW_INSECURE_HTTP: 'true' };
const selected = ['--repo', 'sample/demo'];
async function invoke(args: string[], code = 0) {
  const output = await run(process.execPath, [bin, ...args], { ...env, GITEA_AXI_WRITE_LOG: join(scratch, 'journal-' + scenario, 'writes.log') }, code, scratch);
  assert(!output.includes(token)); return decode(output) as unknown as Output;
}
const expect = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); assertions.push(name); };
async function execute(args: string[], grant: string, code = 0) {
  const argv = ['pr', ...args, ...selected, '--allow-write', grant];
  const preview = await invoke([...argv, '--preview']);
  return invoke([...argv, '--confirm', preview.confirmation], code);
}
let result = 'failed';
let source: unknown;
try {
  source = { head: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), dirty: Boolean((await run('git', ['-C', root, 'status', '--porcelain'])).trim()) };
  await assert.rejects(fetch('http://192.0.2.1'), /fetch failed/);
  await run('npm', ['run', 'build']);
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string }[];
  const tarball = join(scratch, packed[0]!.filename);
  packageSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(scratch, 'prefix'), tarball]);
  bin = join(scratch, 'prefix/node_modules/@knowttl/gitea-axi/dist/cli.js');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  env.GITEA_AXI_ORIGIN = origin; env.GITEA_AXI_TOKEN_ORIGIN = origin;
  if (task === 'S3.3') {
    const control = structuredClone(pulls[1]);
    const unchanged = structuredClone(pulls[0]);
    const beforeInvalid = requests.length;
    const invalid = await invoke(['pr', 'edit', '1', ...selected, '--title', 'X', '--add-reviewer', 'nonexistent', '--allow-write', 'repoEditPullRequest,repoCreatePullReviewRequests', '--preview'], 2);
    expect('Unknown reviewer refuses the entire edit before writing', [invalid.error.code, pulls[0], requests.slice(beforeInvalid).filter(row => row.method !== 'GET')], ['USAGE', unchanged, []]);
    const beforeAuthor = requests.length;
    const authorReview = await invoke(['pr', 'edit', '1', ...selected, '--title', 'X', '--add-reviewer', user.login, '--allow-write', 'repoEditPullRequest,repoCreatePullReviewRequests', '--preview'], 2);
    expect('PR author reviewer refuses the entire edit before writing', [authorReview.error.code, pulls[0], requests.slice(beforeAuthor).filter(row => row.method !== 'GET')], ['USAGE', unchanged, []]);
    for (const [flag, member] of [['--add-reviewer', 'new'], ['--remove-reviewer', 'retained'], ['--add-team-reviewer', 'new-team'], ['--remove-team-reviewer', 'retained-team']]) {
      mode = 'reject-reviewer';
      const previous = structuredClone(pulls[0]);
      const start = requests.length;
      const rejected = await execute(['edit', '1', '--title', 'X', '--body', 'Unapplied field body', flag!, member!], 'repoEditPullRequest,repoCreatePullReviewRequests,repoDeletePullReviewRequests', 1);
      expect(flag + ' rejection leaves field edits unapplied', [rejected.error.code, pulls[0], requests.slice(start).filter(row => row.method !== 'GET').map(row => row.path)], ['WRITE_OUTCOME_UNKNOWN', previous, [base + '/pulls/1/requested_reviewers']]);
      reset();
    }
    mode = '';
    const createArgs = ['pr', 'create', ...selected, '--title', 'Partial creation', '--head', 'feature', '--base', 'main', '--reviewer', 'new', '--allow-write', 'repoCreatePullRequest,repoCreatePullReviewRequests'];
    const beforeGrant = requests.length;
    const missingGrant = createArgs.slice(0, -2).concat('--allow-write', 'repoCreatePullRequest');
    expect('Create requires a reviewer operation grant before creation', [(await invoke([...missingGrant, '--preview'], 1)).error.code, requests.slice(beforeGrant).filter(row => row.method !== 'GET')], ['READ_ONLY', []]);
    const createPreview = await invoke([...createArgs, '--preview']);
    const changedReviewer = [...createArgs];
    changedReviewer[changedReviewer.indexOf('--reviewer') + 1] = 'retained';
    expect('Create confirmation binds the dependent reviewer payload', [(await invoke([...changedReviewer, '--confirm', createPreview.confirmation], 1)).error.code, requests.slice(beforeGrant).filter(row => row.method !== 'GET')], ['CONFIRMATION_MISMATCH', []]);
    mode = 'reject-reviewer';
    const rejectedCreate = await invoke([...createArgs, '--confirm', createPreview.confirmation], 1);
    const partialCreated = pulls.at(-1)!;
    expect('Create reviewer rejection reports created PR identity and step outcomes', [rejectedCreate.error.code, rejectedCreate.error.reason.includes('created PR id=' + partialCreated.id + ' number=' + partialCreated.number), rejectedCreate.error.reason.includes('completed,dispatched'), partialCreated.title, partialCreated.requested_reviewers], ['WRITE_OUTCOME_UNKNOWN', true, true, 'Partial creation', []]);
    const afterRejectedCreate = requests.length;
    mode = '';
    await invoke([...createArgs, '--confirm', createPreview.confirmation], 1);
    await invoke([...createArgs, '--preview'], 1);
    const rawReviewer = join(scratch, 'reviewer.json');
    await writeFile(rawReviewer, JSON.stringify({ reviewers: ['new'], team_reviewers: [] }), { mode: 0o600 });
    expect('Dependent reviewer replay guard also covers the resolved raw route', (await invoke(['api', base + '/pulls/' + partialCreated.number + '/requested_reviewers', '--method', 'POST', '--input', rawReviewer, '--allow-write', 'repoCreatePullReviewRequests', '--preview'], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    expect('Partial creation never retries either write', requests.slice(afterRejectedCreate).filter(row => row.method !== 'GET'), []);
    const reconciliation = await invoke(['write', 'reconcile', createPreview.confirmation]);
    expect('Partial creation reconciles the created PR directly', (reconciliation.observations.find(row => row.path === base + '/pulls/' + partialCreated.number)!.data as Row).id, partialCreated.id);
    reset();
    const beforeAuthorEdit = requests.length;
    await execute(['create', '--title', 'Created PR', '--body', 'Exact PR body', '--head', 'feature', '--base', 'main', '--assignee', 'synthetic', '--label', 'added', '--milestone', 'Release', '--reviewer', 'new', '--team-reviewer', 'new-team'], 'repoCreatePullRequest,repoCreatePullReviewRequests');
    const created = pulls.at(-1)!;
    expect('Create exact refs, body and membership', [created.title, created.body, (created.head as Row).ref, (created.base as Row).ref, created.milestone, created.labels,
      (created.requested_reviewers as Row[]).map(row => row.login), (created.requested_reviewers_teams as Row[]).map(row => row.name)],
    ['Created PR', 'Exact PR body', 'feature', 'main', milestone, [labels[1]], ['new'], ['new-team']]);
    await execute(['edit', '1', '--title', 'Edited', '--body', 'Edited body', '--base', 'main', '--add-assignee', 'new', '--add-label', 'added', '--add-reviewer', 'new', '--add-team-reviewer', 'new-team'], 'repoEditPullRequest,repoCreatePullReviewRequests');
    await execute(['edit', '1', '--remove-reviewer', 'new', '--remove-team-reviewer', 'new-team', '--remove-label', 'added', '--remove-assignee', 'new'], 'repoEditPullRequest,repoDeletePullReviewRequests');
    expect('Reviewer deltas preserve unrelated people and teams', [pulls[0]!.requested_reviewers, pulls[0]!.requested_reviewers_teams], [seed().requested_reviewers, seed().requested_reviewers_teams]);
    expect('Edit preserves identity and applies requested fields', [pulls[0]!.id, pulls[0]!.title, pulls[0]!.body, pulls[0]!.labels], [101, 'Edited', 'Edited body', [labels[0]]]);
    expect('Non-collaborating author changes reviewers without discovery access', requests.slice(beforeAuthorEdit).filter(row => row.path === base + '/reviewers'), []);
    for (const [action, state] of [['close', 'closed'], ['reopen', 'open']] as const) {
      await execute([action, '1', ...(action === 'close' ? ['--comment', 'Closed exactly once'] : [])], 'repoEditPullRequest,issueCreateComment');
      expect(action + ' same PR identity', [pulls[0]!.number, pulls[0]!.state], [1, state]);
    }
    expect('Close comment exact body once on same PR', comments.filter(row => row.body === 'Closed exactly once').map(row => row.issue), [1]);
    await execute(['comment', '1', '--body', 'Standalone PR comment'], 'issueCreateComment');
    expect('Standalone PR comment exact body', [comments.at(-1)!.issue, comments.at(-1)!.body], [1, 'Standalone PR comment']);
    mode = 'fail-comment';
    const partial = await execute(['close', '1', '--comment', 'Failed PR comment'], 'repoEditPullRequest,issueCreateComment', 1);
    expect('Partial closure reports completed then uncertain comment', [partial.error.code, partial.error.reason.includes('completed,dispatched'), pulls[0]!.state], ['WRITE_OUTCOME_UNKNOWN', true, 'closed']);
    expect('Failed close comment is absent', comments.filter(row => row.body === 'Failed PR comment'), []);
    mode = 'wrong-field';
    expect('Edit rejects an unintended read-back field', (await execute(['edit', '1', '--body', 'Check fields'], 'repoEditPullRequest', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = ''; reset();
    await execute(['update-branch', '1'], 'repoUpdatePullRequest');
    const updated = commits.get(String((pulls[0]!.head as Row).sha))!;
    expect('Update graph includes base and previous PR head', (updated.parents as Row[]).map(row => row.sha), [headSHA, baseSHA]);
    mode = 'conflict';
    expect('Update conflict never claims completion', (await execute(['update-branch', '2'], 'repoUpdatePullRequest', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    for (const style of ['merge', 'squash', 'rebase']) {
      mode = ''; reset();
      await execute(['merge', '1', '--method', style, '--match-head-commit', headSHA], 'repoMergePullRequest');
      const final = commits.get(String(pulls[0]!.merge_commit_sha))!;
      expect(style + ' merges intended PR at requested head', [pulls[0]!.merged, pulls[0]!.state, (pulls[0]!.head as Row).sha, branches.get('main')], [true, 'closed', headSHA, final.sha]);
      expect(style + ' final graph parents', (final.parents as Row[]).map(row => row.sha), style === 'merge' ? [baseSHA, headSHA] : style === 'rebase' ? [rebasedFirstSHA] : [baseSHA]);
      if (style === 'rebase') expect('Rebased chain retains both commit messages on the previous base',
        [commits.get(rebasedFirstSHA)!.parents, (commits.get(rebasedFirstSHA)!.commit as Row).message, (final.commit as Row).message], [[{ sha: baseSHA }], 'first', 'feature']);
      reset(); mode = 'wrong-graph';
      expect(style + ' rejects incorrect final graph', (await execute(['merge', '1', '--method', style, '--match-head-commit', headSHA], 'repoMergePullRequest', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    }
    reset(); mode = 'race';
    expect('Head changes between preflight and dispatch refuse merge', (await execute(['merge', '1', '--merge', '--match-head-commit', headSHA], 'repoMergePullRequest', 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    expect('Racing stale head has no merge', [pulls[0]!.merged, branches.get('main')], [false, baseSHA]);
    reset(); mode = '';
    expect('Stale preflight head refuses', (await invoke(['pr', 'merge', '1', ...selected, '--merge', '--match-head-commit', oldSHA, '--allow-write', 'repoMergePullRequest', '--preview'], 1)).error.code, 'STALE_HEAD');
    const before = effects;
    for (const [action, flags] of [['create', ['--draft']], ['create', ['--project', 'unsupported']], ['merge', ['--auto']], ['merge', ['--admin']], ['merge', ['--delete-branch']]] as const) {
      await invoke(['pr', action, ...(action === 'create' ? [] : ['1']), ...selected, ...flags, '--preview'], action === 'create' ? 2 : 1);
    }
    expect('Unsupported flags never mutate', effects, before);
    mode = 'disconnect';
    const uncertain = ['pr', 'comment', '1', ...selected, '--body', 'Uncertain PR comment', '--allow-write', 'issueCreateComment'];
    const preview = await invoke([...uncertain, '--preview']);
    expect('Applied comment then disconnect is uncertain', (await invoke([...uncertain, '--confirm', preview.confirmation], 1)).error.code, 'WRITE_OUTCOME_UNKNOWN');
    mode = '';
    await invoke([...uncertain, '--confirm', preview.confirmation], 1);
    await invoke([...uncertain, '--preview'], 1);
    expect('Unknown PR comment never retries', comments.filter(row => row.body === 'Uncertain PR comment').length, 1);
    expect('Control PR unchanged', pulls[1], control);
  } else {
    const before = requests.length;
    for (const action of ['--approve', '--request-changes', '--comment']) {
      const output = await invoke(['pr', 'review', '1', ...selected, action, '--body', 'Review body', '--match-head-commit', headSHA, '--allow-write', 'repoCreatePullReview', '--preview'], 1);
      expect(action + ' refuses unresolved vendor guarantee', output.error.code, 'CAPABILITY_GAP');
    }
    expect('Unresolved review dispatches no HTTP request', requests.length, before);
    for (const actions of [[], ['--approve', '--comment'], ['--approve', '--request-changes']]) {
      expect('Review requires exactly one action ' + actions.join(','), (await invoke(['pr', 'review', '1', ...actions, ...selected, '--preview'], 2)).error.code, 'USAGE');
    }
    expect('No reviews or other effects posted', effects, 0);
  }
  if (process.env.GITEA_AXI_ARTIUM_ROOT) {
    assert(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const bytes = await readFile(process.env.GITEA_AXI_ARTIUM_MANIFEST);
    const manifest = JSON.parse(String(bytes)) as { fixtureCommit: string };
    artium = { revision: manifest.fixtureCommit, manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      testedHostHead: (await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'rev-parse', 'HEAD'])).trim(),
      testedHostDirty: Boolean((await run('git', ['-C', process.env.GITEA_AXI_ARTIUM_ROOT, 'status', '--porcelain'])).trim()) };
    process.env.NODE_OPTIONS = deny;
    reset(); mode = '';
    host = await readHost({ host: process.env.GITEA_AXI_ARTIUM_ROOT, bin, scratch, origin, token });
    await host.grantWrites(['repoCreatePullRequest', 'repoEditPullRequest', 'issueCreateComment', 'repoUpdatePullRequest', 'repoMergePullRequest']);
    if (task === 'S3.3') {
      for (const [args, grant] of [
        [['create', '--title', 'Hosted PR', '--body', 'Hosted body', '--head', 'feature', '--base', 'main'], 'repoCreatePullRequest'],
        [['edit', '1', '--body', 'Hosted edited body'], 'repoEditPullRequest'],
        [['close', '1', '--comment', 'Hosted close comment'], 'repoEditPullRequest,issueCreateComment'],
        [['reopen', '1'], 'repoEditPullRequest'],
        [['comment', '1', '--body', 'Hosted PR comment'], 'issueCreateComment'],
        [['update-branch', '1'], 'repoUpdatePullRequest'],
      ] as [string[], string][]) {
        const argv = ['pr', ...args, ...selected, '--allow-write', grant];
        const preview = await host.invokeClient([...argv, '--preview']) as Output;
        await host.invokeClient([...argv, '--confirm', preview.confirmation]);
      }
      const argv = ['pr', 'merge', '1', ...selected, '--merge', '--match-head-commit', String((pulls[0]!.head as Row).sha), '--allow-write', 'repoMergePullRequest'];
      const preview = await host.invokeClient([...argv, '--preview']) as Output;
      await host.invokeClient([...argv, '--confirm', preview.confirmation]);
      expect('Hosted public client completes PR lifecycle', [pulls[0]!.merged, pulls.at(-1)!.title, comments.map(row => row.body)], [true, 'Hosted PR', ['Hosted close comment', 'Hosted PR comment']]);
    } else {
      await host.grantWrites(['repoCreatePullReview']);
      const output = await host.invokeClient(['pr', 'review', '1', ...selected, '--approve', '--match-head-commit', headSHA, '--allow-write', 'repoCreatePullReview', '--preview'], 1) as Output;
      expect('Hosted review guarantee remains unresolved', output.error.code, 'CAPABILITY_GAP');
    }
  }
  if (task === 'S3.3') {
    let persisted = '';
    for (const directory of (await readdir(scratch)).filter(name => name.startsWith('journal-'))) {
      const receiptRoot = join(scratch, directory, 'write-receipts');
      persisted += (await Promise.all((await readdir(receiptRoot)).map(name => readFile(join(receiptRoot, name), 'utf8')))).join('');
      try { persisted += await readFile(join(scratch, directory, 'writes.log'), 'utf8'); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    for (const secret of [token, 'Exact PR body', 'Unapplied field body', 'Standalone PR comment', 'Uncertain PR comment']) assert(!persisted.includes(secret));
    assertions.push('PR journal and receipts contain no credentials or request bodies');
  }
  result = 'passed';
} finally {
  if (host) await host.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const reportPath = process.env.GITEA_AXI_REPORT ?? scratch + '-report.json';
  await writeFile(reportPath, JSON.stringify({ task, result, source, packageSha256, assertions, invocations, requests, artium,
    review: 'C043/CX-007 unresolved: no vendor event enum or atomic stale-head guarantee', live: 'pending commissioning', nativeWindows: 'pending' }, null, 2));
  console.log(task + ' ' + result + '; Artium: ' + (host ? result : 'skipped: opt-in frozen fixture required') + '; report: ' + reportPath);
  await rm(scratch, { recursive: true, force: true });
}
