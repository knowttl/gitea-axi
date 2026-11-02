import { collect, object, read } from './api.js';
import type { Row } from './api.js';
import { CliError } from './error.js';
import type { Options } from './reads.js';
import type { Client } from './transport.js';
import type { WritePlan, WriteStep } from './writes.js';

const usage = (message: string): never => { throw new CliError('USAGE', message, 2); };
const gap = (message: string): never => { throw new CliError('CAPABILITY_GAP', message); };
const names = (value: unknown): string[] => value === undefined ? [] : [...new Set((Array.isArray(value) ? value : [value]).map(String))];
const sorted = (values: unknown[]) => [...values].sort();
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const delta = (previous: unknown[], add: unknown, remove: unknown) => [...new Set([...previous.map(String), ...names(add)])].filter(value => !names(remove).includes(value));
const members = (pull: Row, field: string, key: string) => (pull[field] as unknown[] ?? []).map(row => object(row)[key]);

function branchPath(base: string, branch: string): string {
  const segments = branch.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..') || /[\s\\\x00-\x1f\x7f]/.test(branch)) usage('Select a branch without unsafe path segments');
  return base + '/git/refs/heads/' + segments.map(encodeURIComponent).join('/');
}

function branchSHA(value: unknown, branch: string): string {
  if (!Array.isArray(value)) throw new CliError('INVALID_RESPONSE', 'Expected branch references');
  const selected = value.map(object).find(row => row.ref === 'refs/heads/' + branch);
  if (!selected) throw new CliError('NOT_FOUND_OR_HIDDEN', 'The selected branch is missing or hidden');
  const commit = object(selected.object);
  if (commit.type !== 'commit' || typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new CliError('INVALID_RESPONSE', 'Expected an immutable branch commit identity');
  return commit.sha;
}

export function validatePull(operation: string, options: Options) {
  for (const ref of [options.head, options.base]) if (ref !== undefined) branchPath('', String(ref));
  if (operation === 'pr review') {
    if (['approve', 'request-changes', 'comment'].filter(key => options[key]).length !== 1) usage('Choose exactly one of --approve, --request-changes or --comment');
    gap('C043 unresolved: review wire events and atomic stale-head refusal lack vendor evidence; no review will be posted, including with --match-head-commit');
  }
  if (operation === 'pr merge') {
    const styles = ['merge', 'squash', 'rebase'].filter(key => options[key]);
    if (styles.length + Number(options.method !== undefined) !== 1) usage('Choose exactly one of --method, --merge, --squash or --rebase');
    if (!['merge', 'squash', 'rebase'].includes(String(options.method ?? styles[0]))) usage('Supported merge methods: merge, squash, rebase');
    if (!/^[a-f0-9]{40}$/.test(String(options['match-head-commit'] ?? ''))) usage('--match-head-commit requires the full 40-character head SHA');
  }
}

function fields(pull: Row): Row {
  return { title: pull.title, body: pull.body ?? '', state: pull.state, head: object(pull.head).ref, base: object(pull.base).ref,
    assignees: sorted(members(pull, 'assignees', 'login')), labels: sorted(members(pull, 'labels', 'id')),
    milestone: pull.milestone == null ? null : object(pull.milestone).id,
    reviewers: sorted(members(pull, 'requested_reviewers', 'login')), teams: sorted(members(pull, 'requested_reviewers_teams', 'name')) };
}

export async function pullPlan(client: Client, operation: string, base: string, number: string | undefined, options: Options): Promise<WritePlan> {
  const action = operation.split(' ')[1]!;
  const path = base + '/pulls' + (number ? '/' + number : '');
  const steps: WriteStep[] = [];
  const preconditions: Row = {};
  const reads = new Set<string>();
  const snapshot = async (path: string, list = false) => {
    let value: unknown;
    if (list) {
      const page = await collect(client, path);
      if (page.truncated) throw new CliError('INCOMPLETE_READ', 'A complete collection is required before writing');
      value = page.items;
    } else value = await read(client, path);
    preconditions[path] = value; reads.add(path); return value;
  };
  const snapshotBranch = async (branch: string) => branchSHA(await snapshot(branchPath(base, branch), true), branch);
  const add = (method: string, path: string, payload?: unknown) => steps.push({ method, path, ...(payload === undefined ? {} : { payload }) });
  const before = action === 'create' ? undefined : object(await snapshot(path));
  const expected: Row = before ? { id: before.id, number: before.number, ...fields(before), merged: before.merged ?? false, headSHA: object(before.head).sha } :
    { title: '', body: '', state: 'open', merged: false, assignees: [], labels: [], milestone: null, reviewers: [], teams: [] };
  if (action === 'create') await snapshot(path + '?state=all', true);
  if (action === 'create' || action === 'edit') {
    for (const [flag, collection, key] of [['assignee', 'assignees', 'login'], ['team-reviewer', 'teams', 'name']] as const) {
      const requested = action === 'create' ? names(options[flag]) : [...names(options['add-' + flag]), ...names(options['remove-' + flag])];
      if (!requested.length) continue;
      const available = await snapshot(base + '/' + collection, true) as Row[];
      for (const name of requested) {
        const selected = available.find(row => row[key] === name);
        if (!selected) usage('Unknown exact ' + flag + ' name: ' + name);
      }
    }
    const addedReviewers = names(action === 'create' ? options.reviewer : options['add-reviewer']);
    const requestedReviewers = [...new Set([...addedReviewers, ...names(options['remove-reviewer'])])];
    if (requestedReviewers.length) {
      const author = object(action === 'create' ? await snapshot('/api/v1/user') : before!.user);
      for (const name of requestedReviewers) {
        let reviewer: Row;
        try { reviewer = object(await snapshot('/api/v1/users/' + encodeURIComponent(name))); }
        catch (error) {
          if (error instanceof CliError && error.code === 'NOT_FOUND_OR_HIDDEN') usage('Unknown exact reviewer name: ' + name);
          throw error;
        }
        if (reviewer.login !== name) usage('Unknown exact reviewer name: ' + name);
        if (addedReviewers.includes(name) && reviewer.id === author.id) usage('The PR author cannot be requested as a reviewer');
      }
    }
    const payload: Row = {};
    for (const field of ['title', 'body', 'base']) if (options[field] !== undefined) payload[field] = options[field];
    if (action === 'create') {
      for (const field of ['title', 'base', 'head']) if (!options[field]) usage('--' + field + ' is required');
      if (String(options.head).includes(':')) gap('Cross-repository PR creation requires separate head repository verification');
      payload.head = options.head;
      payload.assignees = names(options.assignee);
      expected.reviewers = sorted(addedReviewers);
      expected.teams = sorted(names(options['team-reviewer']));
      expected.headSHA = await snapshotBranch(String(options.head));
    } else {
      if (options['add-assignee'] !== undefined || options['remove-assignee'] !== undefined) payload.assignees = delta(expected.assignees as unknown[], options['add-assignee'], options['remove-assignee']);
    }
    if (options.base !== undefined) await snapshotBranch(String(options.base));
    if (options.milestone !== undefined) {
      const list = await snapshot(base + '/milestones?state=all', true) as Row[];
      const selected = list.find(row => row.title === options.milestone);
      if (!selected) usage('Unknown exact milestone title');
      payload.milestone = selected!.id;
    }
    if (options.label !== undefined || options['add-label'] !== undefined || options['remove-label'] !== undefined) {
      const labels = await snapshot(base + '/labels', true) as Row[];
      const ids = (value: unknown) => names(value).map(name => {
        const label = labels.find(row => row.name === name);
        if (!label) return usage('Unknown exact label name: ' + name);
        return label.id;
      });
      payload.labels = action === 'create' ? ids(options.label) : [...new Set([...(expected.labels as unknown[]), ...ids(options['add-label'])])].filter(id => !ids(options['remove-label']).includes(id));
    }
    for (const field of ['title', 'body', 'base', 'head', 'assignees', 'labels', 'milestone']) if (payload[field] !== undefined) expected[field] = payload[field];
    if (action === 'create') {
      add('POST', path, payload);
      if (addedReviewers.length || names(options['team-reviewer']).length) steps.push({ method: 'POST', path: path + '/0/requested_reviewers',
        payload: { reviewers: addedReviewers, team_reviewers: names(options['team-reviewer']) }, createdPull: true });
    } else {
      for (const [flag, field, wire] of [['reviewer', 'reviewers', 'reviewers'], ['team-reviewer', 'teams', 'team_reviewers']] as const) {
        const previous = expected[field] as unknown[];
        const next = delta(previous, options['add-' + flag], options['remove-' + flag]);
        const added = next.filter(name => !previous.includes(name));
        const removed = previous.filter(name => !next.includes(String(name)));
        if (added.length) add('POST', path + '/requested_reviewers', { [wire]: added });
        if (removed.length) add('DELETE', path + '/requested_reviewers', { [wire]: removed });
        expected[field] = next;
      }
      if (Object.keys(payload).length) add('PATCH', path, payload);
    }
    if (!steps.length && !options.attach) usage('Choose a PR field or membership to edit');
  } else if (action === 'close' || action === 'reopen') {
    expected.state = action === 'close' ? 'closed' : 'open';
    add('PATCH', path, { state: expected.state });
  } else if (action === 'merge') {
    if (expected.headSHA !== options['match-head-commit']) throw new CliError('STALE_HEAD', 'Selected PR head differs from --match-head-commit');
    if (before!.state !== 'open' || before!.merged) usage('Select an open unmerged PR');
    const style = options.method ?? ['merge', 'squash', 'rebase'].find(key => options[key]);
    const payload: Row = { Do: style, head_commit_id: options['match-head-commit'] };
    if (options.subject !== undefined) payload.MergeTitleField = options.subject;
    if (options.body !== undefined) payload.MergeMessageField = options.body;
    if (style === 'rebase') await snapshot(path + '/commits', true);
    await snapshotBranch(String(expected.base));
    add('POST', path + '/merge', payload);
    expected.state = 'closed';
  } else if (action === 'update-branch') {
    await snapshotBranch(String(expected.base));
    add('POST', path + '/update');
  }
  if (action === 'comment' || action === 'close' && options.comment !== undefined) {
    const body = action === 'comment' ? options.body : options.comment;
    if (body === undefined || body === '') usage('--body is required');
    const comments = base + '/issues/' + number + '/comments';
    await snapshot(comments, true);
    add('POST', comments, { body });
  }
  return { target: path, steps, reads: [...reads], preconditions, pull: { expected, action, repository: base } };
}

export async function verifyPull(client: Client, plan: WritePlan, results: unknown[], observations: { path: string; data: unknown }[]) {
  const { expected, action, repository: base } = plan.pull!;
  const before = object(plan.preconditions);
  const mismatch = (): never => { throw new CliError('READBACK_MISMATCH', 'PR read-back did not confirm identity, requested fields or commit graph'); };
  const observation = (path: string) => observations.find(row => row.path === path)?.data;
  let pull: Row;
  if (action === 'create') {
    const result = object(results[0]);
    pull = (observation(plan.target + '?state=all') as Row[]).find(row => row.id === result.id && row.number === result.number) ?? mismatch();
    if ((before[plan.target + '?state=all'] as Row[]).some(row => row.id === pull.id || row.number === pull.number)) mismatch();
  } else {
    pull = object(observation(plan.target));
    if (pull.id !== expected.id || pull.number !== expected.number) mismatch();
  }
  const actual = fields(pull);
  for (const field of Object.keys(actual)) {
    const value = ['assignees', 'labels', 'reviewers', 'teams'].includes(field) ? sorted(expected[field] as unknown[]) : expected[field];
    if (!equal(actual[field], value)) mismatch();
  }
  if (action !== 'update-branch' && object(pull.head).sha !== expected.headSHA) mismatch();
  if (action !== 'merge' && (pull.merged ?? false) !== expected.merged) mismatch();
  for (const [index, step] of plan.steps.entries()) {
    if (!step.path.endsWith('/comments')) continue;
    const comments = observation(step.path) as Row[];
    const previous = before[step.path] as Row[];
    const id = object(results[index]).id;
    const added = comments.filter(row => !previous.some(old => old.id === row.id));
    if (added.length !== 1 || added[0]!.id !== id || added[0]!.body !== object(step.payload).body || previous.some(old => !comments.some(row => equal(row, old)))) mismatch();
  }
  if (action !== 'merge' && action !== 'update-branch') return;
  const baseBranchPath = branchPath(base, String(expected.base));
  const baseSHA = branchSHA(before[baseBranchPath], String(expected.base));
  const commit = async (sha: unknown) => {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return mismatch();
    const path = base + '/git/commits/' + sha;
    const data = object(await read(client, path));
    if (data.sha !== sha || !Array.isArray(data.parents)) mismatch();
    observations.push({ path, data });
    return data;
  };
  if (action === 'update-branch') {
    const required = new Set<unknown>([baseSHA, expected.headSHA]);
    if ([...required].some(sha => typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha))) mismatch();
    const pending = [object(pull.head).sha], visited = new Set<unknown>();
    for (let cursor = 0; cursor < pending.length && visited.size < 1000; cursor++) {
      const sha = pending[cursor];
      if (visited.has(sha)) continue;
      const current = await commit(sha);
      visited.add(current.sha);
      required.delete(current.sha);
      const parents = members(current, 'parents', 'sha');
      for (const parent of parents) required.delete(parent);
      if (!required.size) return;
      pending.push(...parents.filter(parent => !visited.has(parent)));
    }
    mismatch();
  }
  if (pull.merged !== true || !pull.merge_commit_sha) mismatch();
  const finalSHA = branchSHA(observation(baseBranchPath), String(expected.base));
  if (finalSHA !== pull.merge_commit_sha) mismatch();
  const final = await commit(finalSHA);
  const style = object(plan.steps[0]!.payload).Do;
  if (style === 'merge') {
    if (!equal(members(final, 'parents', 'sha'), [baseSHA, expected.headSHA])) mismatch();
  } else if (style === 'squash') {
    if (!equal(members(final, 'parents', 'sha'), [baseSHA]) || finalSHA === expected.headSHA) mismatch();
  } else {
    const originals = before[plan.target + '/commits'] as Row[];
    if (!originals.length) mismatch();
    const bySHA = new Map(originals.map(row => [row.sha, row]));
    let original = bySHA.get(expected.headSHA);
    let current = final;
    for (let index = 0; index < originals.length; index++) {
      const parents = members(current, 'parents', 'sha');
      if (!original || parents.length !== 1 || object(current.commit).message !== object(original.commit).message) mismatch();
      if (index === originals.length - 1) { if (parents[0] !== baseSHA) mismatch(); }
      else {
        const originalParents = members(original!, 'parents', 'sha');
        if (originalParents.length !== 1) mismatch();
        original = bySHA.get(originalParents[0]);
        current = await commit(parents[0]);
      }
    }
  }
}
