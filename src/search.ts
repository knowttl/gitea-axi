import { collect, object, read } from './api.js';
import type { Page, Row } from './api.js';
import type { Client } from './transport.js';
import { CliError } from './error.js';
import { issue, issueFields, positive, repository, selectedFields } from './reads.js';
import type { Options } from './reads.js';

export function validateSearch(kind: string, query: string, options: Options) {
  if (!query.trim() || /\S+:\S*/.test(query)) throw new CliError('USAGE', 'Use plain search text and explicit flags; query qualifiers are unsupported', 2);
  if (kind === 'code') throw new CliError('CAPABILITY_GAP', 'Indexed code search is unresolved; repository contents are not indexed search');
  const allowed = kind === 'issues' || kind === 'prs' ? ['owner', 'state', 'label', 'assignee', 'author', 'sort', 'order', 'limit', 'fields', ...(kind === 'prs' ? ['draft'] : [])] :
    kind === 'repos' ? ['owner', 'sort', 'order', 'limit', 'language', 'stars', 'fields'] : ['author', 'sort', 'order', 'limit', 'revision', 'fields'];
  for (const key of Object.keys(options)) {
    if (!['origin', 'allow-insecure-http', 'config', 'profile', 'repo'].includes(key) && !allowed.includes(key)) throw new CliError('CAPABILITY_GAP', '--' + key + ' is not evidenced for search ' + kind);
  }
  positive(options.limit, 1000, 1000);
  if (options.state && !['open', 'closed', 'all'].includes(String(options.state))) throw new CliError('USAGE', '--state must be open, closed or all', 2);
  const sorts = kind === 'repos' ? ['name', 'created', 'updated', 'stars'] : kind === 'commits' ? ['created'] : ['created', 'updated', 'comments'];
  if (options.sort && !sorts.includes(String(options.sort))) throw new CliError('USAGE', 'Choose --sort ' + sorts.join(','), 2);
  if (options.order && !['asc', 'desc'].includes(String(options.order))) throw new CliError('USAGE', '--order must be asc or desc', 2);
  if (options.stars && !/^(?:>=|<=|>|<|=)?\d+$/.test(String(options.stars))) throw new CliError('USAGE', '--stars requires an integer comparison such as >100', 2);
  selectedFields(options, kind === 'repos' ? ['id', 'full_name', 'description', 'language', 'stars_count'] : kind === 'commits' ? ['sha', 'message', 'author', 'created', 'url'] : issueFields.concat(['closedAt', 'commentsCount', 'isLocked', ...(kind === 'prs' ? ['isDraft'] : [])]), []);
}

export async function search(client: Client, kind: string, query: string, options: Options) {
  const target = typeof options.repo === 'string' ? repository(options.repo, client.origin) : undefined;
  const base = target ? '/api/v1/repos/' + target.split('/').map(encodeURIComponent).join('/') : undefined;
  let page: Page;
  let revision: unknown = null;
  if (kind === 'commits') {
    if (!base) throw new CliError('USAGE', 'Commit search requires --repo OWNER/NAME', 2);
    const repo = object(await read(client, base));
    const ref = String(options.revision ?? repo.default_branch);
    const commit = object(await read(client, base + '/git/commits/' + encodeURIComponent(ref)));
    if (typeof commit.sha !== 'string' || !commit.sha) throw new CliError('INVALID_RESPONSE', 'Revision has no commit SHA');
    revision = commit.sha;
    page = await collect(client, base + '/commits?sha=' + encodeURIComponent(commit.sha));
  } else if (kind === 'repos') {
    page = await collect(client, '/api/v1/repos/search?q=' + encodeURIComponent(query) + '&includeDesc=true', 'data');
  } else {
    page = await collect(client, base ? base + (kind === 'prs' ? '/pulls' : '/issues') + '?state=all' + (kind === 'issues' ? '&type=issues' : '') :
      '/api/v1/repos/issues/search?state=all&type=' + (kind === 'prs' ? 'pulls' : 'issues') + '&q=' + encodeURIComponent(query) + (options.owner ? '&owner=' + encodeURIComponent(String(options.owner)) : ''));
  }
  const needle = query.toLowerCase();
  const rows = page.items.filter(row => {
    const fullName = kind === 'repos' ? row.full_name : row.repository ? object(row.repository).full_name : target;
    if (target && kind === 'repos' && fullName !== target) return false;
    if (options.owner && String(fullName).split('/')[0] !== options.owner) return false;
    if (kind === 'repos') {
      if (!String(row.full_name ?? '').toLowerCase().includes(needle) && !String(row.description ?? '').toLowerCase().includes(needle)) return false;
      if (options.language && String(row.language).toLowerCase() !== String(options.language).toLowerCase()) return false;
      if (options.stars) {
        const [, op, value] = /^(>=|<=|>|<|=)?(\d+)$/.exec(String(options.stars))!;
        const count = Number(row.stars_count), expected = Number(value);
        if (!(op === '>' ? count > expected : op === '<' ? count < expected : op === '>=' ? count >= expected : op === '<=' ? count <= expected : count === expected)) return false;
      }
    } else if (kind === 'commits') {
      if (!String(object(row.commit).message).toLowerCase().includes(needle)) return false;
      if (options.author && (!row.author || object(row.author).login !== options.author)) return false;
    } else {
      if (kind === 'issues' && row.pull_request) return false;
      if (!(String(row.title) + '\n' + String(row.body ?? '')).toLowerCase().includes(needle)) return false;
      if (options.state && options.state !== 'all' && row.state !== options.state) return false;
      if (options.author && (!row.user || object(row.user).login !== options.author)) return false;
      if (options.assignee && !((row.assignees ?? []) as Row[]).some(user => user.login === options.assignee)) return false;
      if (options.label && !((row.labels ?? []) as Row[]).some(label => String(options.label).split(',').includes(String(label.name)))) return false;
      if (options.draft && row.draft !== true) return false;
    }
    return true;
  });
  const key = options.sort === 'updated' ? 'updated_at' : options.sort === 'comments' ? 'comments' : options.sort === 'stars' ? 'stars_count' : options.sort === 'name' ? 'full_name' : kind === 'commits' ? 'created' : 'created_at';
  rows.sort((a, b) => {
    const left = a[key] ?? '', right = b[key] ?? '';
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return (compared || String(a.id ?? a.sha).localeCompare(String(b.id ?? b.sha))) * (options.order === 'asc' ? 1 : -1);
  });
  const limit = positive(options.limit, 1000, 1000);
  const fields = typeof options.fields === 'string' ? options.fields.split(',') : kind === 'repos' ? ['id', 'full_name', 'description'] : kind === 'commits' ? ['sha', 'message', 'author'] : ['number', 'title', 'state'];
  return { items: rows.slice(0, limit).map(row => {
    const projection = kind === 'repos' ? row : kind === 'commits' ? { sha: row.sha, message: object(row.commit).message, author: row.author, created: row.created, url: row.html_url } :
      { ...issue(row, Boolean(options.fields)), closedAt: row.closed_at ?? null, commentsCount: row.comments ?? 0, isLocked: row.is_locked ?? false, isDraft: row.draft ?? null };
    return { ...(kind === 'issues' || kind === 'prs' ? { repository: row.repository ? object(row.repository).full_name : target } : {}), ...Object.fromEntries(fields.map(field => [field, projection[field]])) };
  }), count: Math.min(rows.length, limit), total: page.truncated ? null : rows.length, truncated: page.truncated || rows.length > limit, next: page.next,
  scope: { repository: target ?? 'visible repositories', owner: options.owner ?? null, revision, pages: 'maximum 20 pages / 1000 candidates per collection', indexed: false },
  continuation: page.truncated || rows.length > limit };
}
