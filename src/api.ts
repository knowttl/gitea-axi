import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { CliError } from './error.js';
import type { Client } from './transport.js';

export type Row = Record<string, unknown>;
const vendor = JSON.parse(readFileSync(new URL('../schemas/vendor.json', import.meta.url), 'utf8'));
const routes: { path: string; operation: string; effect: string; schema: object | null }[] = JSON.parse(readFileSync(new URL('../generated/routes.json', import.meta.url), 'utf8'));
routes.sort((a, b) => b.path.replace(/\{[^}]+\}/g, '').length - a.path.replace(/\{[^}]+\}/g, '').length);
const required: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state'], PullRequest: ['id', 'number', 'title', 'state', 'head', 'base'],
  Label: ['id', 'name', 'color'], Repository: ['id', 'full_name', 'default_branch'], User: ['id', 'login'],
  Comment: ['id', 'body', 'user'], PullReview: ['id', 'user', 'state', 'body', 'commit_id'],
  CommitStatus: ['id', 'context', 'status'], Milestone: ['id', 'title'],
  PRBranchInfo: ['sha', 'ref'], CombinedStatus: ['sha', 'statuses', 'total_count'],
};
for (const [name, fields] of Object.entries(required)) {
  if (vendor.definitions[name]) vendor.definitions[name].required = fields;
}
// Gitea's Go pointer fields and nil slices serialize as null, which Swagger 2 cannot express.
for (const definition of Object.values(vendor.definitions) as { properties?: Record<string, { $ref?: string; type?: string; format?: string }> }[]) {
  for (const [key, property] of Object.entries(definition.properties ?? {})) {
    if (property.$ref && !['state', 'status'].includes(key) || property.type === 'array' || property.format === 'date-time') {
      definition.properties![key] = { anyOf: [property, { type: 'null' }] } as typeof property;
    }
  }
}
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('INVALID_RESPONSE', 'Expected an object from Gitea');
  return value as Row;
}

export function routeFor(path: string) {
  const route = routes.find(route => new RegExp('^' + route.path.replace(/[.]/g, '\\.').replace(/\{[^}]+\}/g, '[^/]+') + '$').test(path));
  if (route?.effect === 'admin') throw new CliError('READ_ONLY', 'Administrative API routes are refused; only metadata reads are available');
  if (route?.effect === 'credential') throw new CliError('READ_ONLY', 'Credential-bearing API routes are refused; only metadata reads are available');
  if (route?.effect === 'download') throw new CliError('READ_ONLY', 'Text and binary download routes are refused; only JSON metadata reads are available');
  if (!route || route.effect !== 'read') throw new CliError('READ_ONLY', 'Only classified metadata reads are available');
  return route;
}

export function validate(path: string, value: unknown): unknown {
  const route = routeFor(path);
  if (route.schema) {
    let validator = validators.get(route.path);
    if (!validator) {
      validator = ajv.compile({ ...route.schema, definitions: vendor.definitions });
      validators.set(route.path, validator);
    }
    if (!validator(value)) throw new CliError('INVALID_RESPONSE', route.operation + ' returned invalid fields');
  }
  return value;
}

export function rawPath(input: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(input); } catch { throw new CliError('USAGE', 'Malformed API path', 2); }
  if (/^[a-z]+:/i.test(input) || input.startsWith('//') || /[\\#\s]/.test(decoded) || decoded.includes('%') ||
      decoded.split(/[/?]/).some(part => part === '.' || part === '..')) throw new CliError('USAGE', 'Use a relative API path without traversal', 2);
  const [pathname, query = ''] = input.split('?');
  for (const key of new URLSearchParams(query).keys()) {
    if (/token|secret|password|authorization|api.?key/i.test(key)) throw new CliError('CONFIG_INVALID', 'Secret query fields are refused');
  }
  const path = pathname === '/swagger.v1.json' ? pathname : pathname?.startsWith('/api/v1/') ? pathname : '/api/v1/' + pathname?.replace(/^\//, '');
  if (path !== '/swagger.v1.json') routeFor(path);
  return path + (query ? '?' + query : '');
}

export async function read(client: Client, path: string): Promise<unknown> {
  const value = await client.get(path);
  return validate(path.split('?')[0]!, value);
}

export interface Page { items: Row[]; total: number | null; next: string | null; truncated: boolean }

function nextPage(headers: Headers, path: string, origin: string): string | null {
  const target = headers.get('link')?.split(',').find(part => /rel="?next"?/.test(part))?.match(/<([^>]+)>/)?.[1];
  if (!target) return null;
  const url = new URL(target, new URL(path, origin));
  if (url.origin !== origin || url.pathname !== new URL(path, origin).pathname || url.username || url.password || url.hash) {
    throw new CliError('UNSAFE_PAGINATION', 'Pagination must stay on the selected origin and collection');
  }
  return rawPath(url.pathname + url.search);
}

export async function rawRead(client: Client, path: string) {
  const response = await client.request(path);
  const data = path === '/swagger.v1.json' ? response.data : validate(new URL(path, client.origin).pathname, response.data);
  const count = response.headers.get('x-total-count');
  return { data, total: count && /^\d+$/.test(count) ? Number(count) : null, next: nextPage(response.headers, path, client.origin), truncated: false };
}

export async function collect(client: Client, path: string, envelope?: string): Promise<Page> {
  let next: string | null = path + (path.includes('?') ? '&' : '?') + 'limit=50&page=1';
  const seenPages = new Set<string>();
  const items = new Map<string, Row>();
  let total: number | null = null;
  while (next && seenPages.size < 20 && items.size < 1000 && Date.now() < client.deadline) {
    if (seenPages.has(next)) throw new CliError('INVALID_RESPONSE', 'Gitea repeated a pagination URL');
    seenPages.add(next);
    const response = await client.request(next);
    const data = validate(new URL(next, client.origin).pathname, response.data);
    const rows = envelope ? object(data)[envelope] : data;
    if (!Array.isArray(rows)) throw new CliError('INVALID_RESPONSE', 'Expected a Gitea list' + (envelope ? ' envelope ' + envelope : ''));
    for (const value of rows) {
      const row = object(value);
      const id = row.id ?? row.number ?? row.sha ?? row.filename ?? (row.user && row.content ? String(object(row.user).id) + ':' + row.content : undefined);
      if (typeof id !== 'number' && typeof id !== 'string') throw new CliError('INVALID_RESPONSE', 'List record has no identity');
      items.set(String(id), row);
    }
    const count = response.headers.get('x-total-count');
    if (count && /^\d+$/.test(count)) total = Number(count);
    if (envelope && typeof object(data).total_count === 'number') total = object(data).total_count as number;
    const link = response.headers.get('link');
    next = nextPage(response.headers, path, client.origin);
    if (!next && !link && rows.length >= 50) {
      const url = new URL([...seenPages].at(-1)!, client.origin);
      url.searchParams.set('page', String(Number(url.searchParams.get('page')) + 1));
      next = url.pathname + url.search;
    }
  }
  return { items: [...items.values()], total, next, truncated: next !== null };
}
