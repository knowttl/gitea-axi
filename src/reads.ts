import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './error.js';
import { collect, object, read } from './api.js';
import type { Row, Page } from './api.js';
import type { Client } from './transport.js';

export type Options = Record<string, string | string[] | boolean | undefined>;
const scalarFields: Record<string, string> = {
  additions: 'additions', body: 'body', changedFiles: 'changed_files', closedAt: 'closed_at', createdAt: 'created_at',
  deletions: 'deletions', fullDatabaseId: 'id', isDraft: 'draft', maintainerCanModify: 'allow_maintainer_edit',
  mergedAt: 'merged_at', number: 'number', title: 'title', updatedAt: 'updated_at', url: 'html_url',
};
const gaps = ['autoMergeRequest', 'closingIssuesReferences', 'id', 'mergeStateStatus', 'potentialMergeCommit', 'projectCards', 'projectItems', 'reviewDecision'];
export const prFields = [...Object.keys(scalarFields), ...gaps, 'assignees', 'author', 'baseRefName', 'baseRefOid', 'closed', 'comments', 'commits', 'files',
  'headRefName', 'headRefOid', 'headRepository', 'headRepositoryOwner', 'isCrossRepository', 'labels', 'latestReviews', 'mergeCommit',
  'mergeable', 'mergedBy', 'milestone', 'reactionGroups', 'reviewRequests', 'reviews', 'state', 'statusCheckRollup'];
export const issueFields = ['number', 'title', 'state', 'body', 'author', 'assignees', 'labels', 'milestone', 'createdAt', 'updatedAt', 'url'];

export function selectedFields(options: Options, allowed: string[], unavailable = gaps): string[] | undefined {
  if (typeof options.fields !== 'string') return;
  const fields = options.fields.split(',');
  if (fields.some(field => !allowed.includes(field)) || new Set(fields).size !== fields.length) throw new CliError('USAGE', 'Unknown or repeated field; choose ' + allowed.join(','), 2);
  const gap = fields.find(field => unavailable.includes(field));
  if (gap) throw new CliError('CAPABILITY_GAP', gap + ' has no evidenced Gitea 1.23.4 equivalent' + (gap === 'id' ? '; fullDatabaseId is the numeric vendor ID, not a GraphQL node ID' : ''));
  if (options.full || options.comments || options.reviews || options.checks) throw new CliError('USAGE', '--fields cannot combine with --full, --comments, --reviews or --checks', 2);
  return fields;
}

export function positive(value: Options[string], fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new CliError('USAGE', 'Expected a positive integer up to ' + maximum, 2);
  return Number(value);
}

export function repository(explicit: string | boolean | undefined, origin: string): string {
  if (typeof explicit === 'string') {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(explicit)) throw new CliError('USAGE', '--repo must be OWNER/NAME', 2);
    return explicit;
  }
  if (process.env.GITEA_AXI_PROFILE === 'artium') throw new CliError('USAGE', 'Hosted calls require --repo OWNER/NAME', 2);
  let remote: string;
  try { remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new CliError('USAGE', 'Select --repo OWNER/NAME or a matching origin remote', 2); }
  let url: URL;
  try { url = new URL(remote.replace(/^git@([^:]+):(.+)$/, 'ssh://git@$1/$2')); }
  catch { throw new CliError('USAGE', 'Remote must identify a Gitea host; use --repo', 2); }
  const target = new URL(origin);
  if (url.hostname !== target.hostname || (url.port && url.port !== target.port)) throw new CliError('USAGE', 'Remote host does not match the selected credential origin; use --repo', 2);
  return repository(url.pathname.slice(1).replace(/\.git$/, ''), origin);
}

const user = (value: unknown) => value == null ? null : { login: object(value).login, name: object(value).full_name ?? null };
const users = (value: unknown) => value == null ? [] : (value as unknown[]).map(user);
const label = (value: unknown) => { const row = object(value); return { name: row.name, color: row.color, description: row.description ?? null }; };
function preview(body: unknown, full: boolean) {
  const text = typeof body === 'string' ? body : '';
  return full || text.length <= 1000 ? text : text.slice(0, 1000) + `... (truncated, ${text.length} chars total; use --full)`;
}

export function issue(row: Row, full = false): Row {
  return { number: row.number, title: row.title, state: row.state, body: preview(row.body, full), author: user(row.user),
    assignees: users(row.assignees), labels: ((row.labels ?? []) as unknown[]).map(label), milestone: row.milestone == null ? null : { title: object(row.milestone).title },
    createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null, url: row.html_url ?? null };
}

export function listOptions(options: Options) {
  const limit = positive(options.limit, 30, 1000);
  if (options.state !== undefined && !['open', 'closed', 'all'].includes(String(options.state))) throw new CliError('USAGE', '--state must be open, closed or all', 2);
  if (options.sort !== undefined && !['created', 'updated', 'number', 'comments'].includes(String(options.sort))) throw new CliError('USAGE', 'Unsupported --sort', 2);
  if (options.order !== undefined && !['asc', 'desc'].includes(String(options.order))) throw new CliError('USAGE', '--order must be asc or desc', 2);
  return limit;
}

export async function listIssues(client: Client, base: string, kind: 'issue' | 'pr', options: Options) {
  const limit = listOptions(options);
  const fields = selectedFields(options, kind === 'pr' ? issueFields.concat(['isDraft', 'headRefName', 'baseRefName']) : issueFields) ?? ['number', 'title', 'state'];
  let milestone: unknown;
  if (typeof options.milestone === 'string') {
    const page = await collect(client, base + '/milestones?state=all');
    milestone = page.items.find(row => row.title === options.milestone)?.id;
    if (milestone === undefined) throw new CliError('USAGE', 'Unknown milestone name', 2);
  }
  const page = await collect(client, base + (kind === 'pr' ? '/pulls' : '/issues') + '?state=all' + (kind === 'issue' ? '&type=issues' : ''));
  const rows = page.items.filter(row => (kind !== 'issue' || !row.pull_request) &&
    (options.state === 'all' || row.state === (options.state ?? 'open')) &&
    (!options.author || (row.user && object(row.user).login === options.author)) &&
    (!options.assignee || ((row.assignees ?? []) as Row[]).some(item => item.login === options.assignee)) &&
    (!options.label || ((row.labels ?? []) as Row[]).some(item => item.name === options.label)) &&
    (milestone === undefined || (row.milestone && object(row.milestone).id === milestone)));
  const sort = options.sort === 'number' ? 'number' : options.sort === 'comments' ? 'comments' : options.sort === 'updated' ? 'updated_at' : 'created_at';
  rows.sort((a, b) => {
    const left = a[sort] ?? '', right = b[sort] ?? '';
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return (comparison || Number(a.number) - Number(b.number)) * (options.order === 'asc' ? 1 : -1);
  });
  return { items: rows.slice(0, limit).map(row => {
    const projection = { ...issue(row), isDraft: row.draft ?? null, headRefName: row.head ? object(row.head).ref : null, baseRefName: row.base ? object(row.base).ref : null };
    return Object.fromEntries(fields.map(field => [field, projection[field as keyof typeof projection]]));
  }), count: Math.min(rows.length, limit), total: page.truncated ? null : rows.length, vendor_total: page.total,
  truncated: page.truncated || rows.length > limit, next: page.next, continuation: page.truncated || rows.length > limit,
  help: `gitea-axi ${kind} view <number> --repo ${base.split('/').slice(-2).join('/')}` };
}

async function complete(client: Client, path: string): Promise<Row[]> {
  const page = await collect(client, path);
  if (page.truncated) throw new CliError('RESPONSE_LIMIT', 'Related collection exceeds the bounded read; use the raw API to page explicitly');
  return page.items;
}

async function reviews(client: Client, path: string, full: boolean) {
  const rows = await complete(client, path + '/reviews');
  const result = [];
  for (const row of rows) {
    const comments = await complete(client, path + '/reviews/' + row.id + '/comments');
    result.push({ id: row.id, author: user(row.user), state: row.state, dismissed: row.dismissed ?? false, stale: row.stale ?? false, body: preview(row.body, full), commit: { oid: row.commit_id },
      submittedAt: row.submitted_at ?? null, comments: comments.map(comment => ({ id: comment.id, body: preview(comment.body, full), path: comment.path, position: comment.position, commit: { oid: comment.commit_id } })) });
  }
  return result;
}

export async function checks(client: Client, base: string, sha: string) {
  const combined = object(await read(client, base + '/commits/' + encodeURIComponent(sha) + '/status'));
  if (combined.sha !== sha) throw new CliError('INVALID_RESPONSE', 'Check response does not match the pull request head SHA');
  const statuses = await complete(client, base + '/commits/' + encodeURIComponent(sha) + '/statuses');
  statuses.sort((a, b) => Number(b.id) - Number(a.id));
  const latest = new Map<unknown, Row>();
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status);
  const items = [...latest.values()].map(row => ({ name: row.context, state: row.status, description: row.description ?? null, url: row.target_url ?? null }));
  const passed = items.filter(row => row.state === 'success').length;
  const failed = items.filter(row => ['failure', 'error'].includes(String(row.state))).length;
  const pending = items.length - passed - failed;
  return { head: sha, items, passed, failed, pending, exitCode: !items.length || failed ? 1 : pending ? 8 : 0 };
}

export async function watchChecks(client: Client, base: string, number: string, options: Options) {
  const seconds = positive(options.timeout, 30, 3600);
  const interval = positive(options.interval, 5, 60) * 1000;
  const stop = Date.now() + seconds * 1000;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    while (true) {
      const pull = object(await read(client, base + '/pulls/' + number));
      const sha = object(pull.head).sha;
      if (typeof sha !== 'string' || !sha) throw new CliError('INVALID_RESPONSE', 'Pull request head SHA is missing');
      const result = await checks(client, base, sha);
      if (!options.watch || !result.pending || result.failed || Date.now() >= stop || controller.signal.aborted) return { ...result, cancelled: controller.signal.aborted };
      await delay(Math.min(interval, Math.max(1, stop - Date.now())), undefined, { signal: controller.signal }).catch(error => {
        if (!controller.signal.aborted) throw error;
      });
      if (Date.now() >= stop || controller.signal.aborted) return { ...result, cancelled: controller.signal.aborted };
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export async function view(client: Client, base: string, kind: 'issue' | 'pr', number: string, options: Options) {
  const fields = selectedFields(options, kind === 'pr' ? prFields : issueFields);
  const path = base + (kind === 'pr' ? '/pulls/' : '/issues/') + number;
  const row = object(await read(client, path));
  if (row.number !== Number(number)) throw new CliError('INVALID_RESPONSE', 'Response number does not match the selected item');
  const result = issue(row, Boolean(options.full || fields));
  const requested = new Set(fields ?? []);
  if (options.comments || requested.has('comments')) result.comments = (await complete(client, base + '/issues/' + number + '/comments')).map(comment => ({ id: comment.id, author: user(comment.user), body: preview(comment.body, Boolean(options.full || fields)), createdAt: comment.created_at ?? null }));
  if (kind === 'pr') {
    const head = object(row.head), tail = object(row.base);
    if (typeof head.sha !== 'string' || !head.sha) throw new CliError('INVALID_RESPONSE', 'Pull request head SHA is missing');
    Object.assign(result, { headRefOid: head.sha, headRefName: head.ref ?? null, baseRefOid: tail.sha ?? null, baseRefName: tail.ref ?? null, isDraft: row.draft ?? null });
    if (fields) {
      for (const [field, key] of Object.entries(scalarFields)) if (requested.has(field)) result[field] = row[key] ?? null;
      Object.assign(result, { closed: row.state === 'closed' || row.merged === true, state: row.merged ? 'MERGED' : String(row.state).toUpperCase(),
        headRepository: head.repo == null ? null : { name: object(head.repo).name, nameWithOwner: object(head.repo).full_name },
        headRepositoryOwner: head.repo == null ? null : user(object(head.repo).owner), isCrossRepository: head.repo_id == null || tail.repo_id == null ? null : head.repo_id !== tail.repo_id,
        mergeCommit: row.merge_commit_sha ? { oid: row.merge_commit_sha } : null, mergedBy: user(row.merged_by),
        mergeable: row.mergeable == null ? 'UNKNOWN' : row.mergeable ? 'MERGEABLE' : 'CONFLICTING', reviewRequests: users(row.requested_reviewers) });
    }
    if (options.reviews || requested.has('reviews') || requested.has('latestReviews')) {
      const all = await reviews(client, path, Boolean(options.full || fields));
      result.reviews = all;
      if (requested.has('latestReviews')) {
        const latest = new Map<unknown, typeof all[number]>();
        for (const review of [...all].sort((a, b) => Number(a.id) - Number(b.id))) latest.set(review.author?.login, review);
        result.latestReviews = [...latest.values()];
      }
    }
    if (options.checks || requested.has('statusCheckRollup')) result.statusCheckRollup = { ...await checks(client, base, head.sha), source: 'commit-statuses', partial: true };
    if (requested.has('commits')) result.commits = (await complete(client, path + '/commits')).map(commit => ({ oid: commit.sha, message: object(commit.commit).message }));
    if (requested.has('files')) result.files = (await complete(client, path + '/files')).map(file => ({ path: file.filename, additions: file.additions, deletions: file.deletions, status: file.status }));
    if (requested.has('reactionGroups')) {
      const groups = new Map<unknown, Row[]>();
      for (const reaction of await complete(client, base + '/issues/' + number + '/reactions')) groups.set(reaction.content, [...(groups.get(reaction.content) ?? []), reaction]);
      result.reactionGroups = [...groups].map(([content, reactions]) => ({ content, users: { totalCount: reactions.length } }));
    }
  }
  return fields ? Object.fromEntries(fields.map(field => [field, result[field] ?? null])) : result;
}

export function boundedList(page: Page, limit: number, fields: string[]) {
  return { items: page.items.slice(0, limit).map(row => Object.fromEntries(fields.map(key => [key, row[key] ?? null]))),
    count: Math.min(page.items.length, limit), total: page.total, next: page.next,
    truncated: page.truncated || page.items.length > limit, continuation: page.truncated || page.items.length > limit };
}
