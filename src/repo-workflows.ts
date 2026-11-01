import { object, read, resolveCommit } from './api.js';
import type { Row } from './api.js';
import { CliError } from './error.js';
import type { Options } from './reads.js';
import { repository } from './reads.js';
import type { Client } from './transport.js';
import type { WritePlan } from './writes.js';

const usage = (message: string): never => { throw new CliError('USAGE', message, 2); };
export const repoPath = (name: string) => '/api/v1/repos/' + name.split('/').map(encodeURIComponent).join('/');

export function validateRepositoryWorkflow(operation: string, options: Options) {
  if ((options.push || options.remote) && !options.source) usage('--push and --remote require --source');
  if (['source', 'push', 'remote', 'clone'].some(key => options[key] !== undefined)) {
    throw new CliError('CAPABILITY_GAP', 'Workspace options require the deferred local workspace workflow; use API-only arguments');
  }
  if (options.visibility === 'internal') throw new CliError('CAPABILITY_GAP', 'Internal visibility is unsupported by the Gitea contract');
  if (operation === 'repo create' && Boolean(options.public) === Boolean(options.private)) usage('Choose exactly --public or --private');
  if (options.visibility !== undefined && !['public', 'private'].includes(String(options.visibility))) usage('--visibility must be public or private');
}

export async function optionalRead(client: Client, path: string): Promise<unknown | null> {
  try { return await read(client, path); }
  catch (error) { if (error instanceof CliError && error.code === 'NOT_FOUND_OR_HIDDEN') return null; throw error; }
}

export async function repositoryPlan(client: Client, operation: string, selection: string | undefined, options: Options): Promise<WritePlan> {
  const before: Row = {};
  const action = operation.split(' ')[1]!;
  if (selection && options.repo) usage('Choose a positional repository or --repo once');
  const selected = selection ?? (typeof options.repo === 'string' ? options.repo : undefined);
  if (action === 'edit') {
    const base = repoPath(repository(selected, client.origin));
    const current = object(await read(client, base));
    const payload: Row = {};
    for (const [flag, field] of [['description', 'description'], ['default-branch', 'default_branch'], ['enable-issues', 'has_issues'], ['enable-wiki', 'has_wiki']]) {
      if (options[flag!] !== undefined) payload[field!] = options[flag!];
    }
    if (options.visibility !== undefined) payload.private = options.visibility === 'private';
    if (!Object.keys(payload).length) usage('Select at least one repository field to edit');
    return { target: base, steps: [{ method: 'PATCH', path: base, payload }], reads: [base], preconditions: current,
      workflow: { path: base, expected: { id: current.id, full_name: current.full_name, ...payload } } };
  }
  const user = object(await read(client, '/api/v1/user'));
  let owner = String(user.login), name: string, source: Row | undefined, sourcePath: string | undefined;
  if (action === 'fork') {
    sourcePath = repoPath(repository(selected, client.origin));
    source = object(await read(client, sourcePath)); before[sourcePath] = source;
    name = String(source.full_name).split('/')[1]!;
    if (options.org) owner = String(options.org);
  } else {
    if (!selected) usage('Select the new repository name or OWNER/NAME');
    const full = selected!.includes('/') ? selected! : owner + '/' + selected;
    repository(full, client.origin);
    [owner, name] = full.split('/') as [string, string];
    if (options.template) {
      sourcePath = repoPath(repository(String(options.template), client.origin));
      source = object(await read(client, sourcePath));
      if (source.template !== true) usage('--template must select a template repository');
      before[sourcePath] = source;
    }
  }
  repository(owner + '/' + name!, client.origin);
  const base = repoPath(owner + '/' + name!);
  if (await optionalRead(client, base) !== null) throw new CliError('ALREADY_EXISTS', 'The selected destination repository already exists');
  before[base] = null;
  if (owner !== user.login) before.owner = await read(client, '/api/v1/orgs/' + encodeURIComponent(owner));
  else before.owner = user;
  let path: string, payload: Row;
  let expected: Row;
  let content: { base: string; ref: string; expected: unknown } | undefined;
  if (action === 'fork') {
    path = sourcePath + '/forks'; payload = owner === user.login ? {} : { organization: owner };
    expected = { full_name: owner + '/' + name!, private: source!.private, description: source!.description, fork: true, parent: { id: source!.id } };
  } else {
    payload = { name: name!, private: Boolean(options.private), description: options.description ?? '' };
    expected = { full_name: owner + '/' + name!, private: payload.private, description: payload.description };
    if (source) {
      path = sourcePath + '/generate';
      Object.assign(payload, { owner, git_content: true });
      const commit = await resolveCommit(client, sourcePath!, String(source.default_branch));
      const tree = object(await read(client, sourcePath + '/git/trees/' + commit.sha + '?recursive=true'));
      if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new CliError('INCOMPLETE_READ', 'Template content requires a complete tree');
      if (tree.tree.some(item => object(item).path === '.gitea/template')) throw new CliError('CAPABILITY_GAP', 'Transforming templates not yet supported');
      before.content = tree;
      content = { base, ref: String(source.default_branch), expected: treeEntries(tree.tree) };
      expected.default_branch = source.default_branch;
      payload.default_branch = source.default_branch;
    } else path = owner === user.login ? '/api/v1/user/repos' : '/api/v1/orgs/' + encodeURIComponent(owner) + '/repos';
  }
  expected.owner = { login: owner };
  return { target: base, steps: [{ method: 'POST', path, payload }], reads: [base], preconditions: before,
    workflow: { path: base, expected, created: true, ...(content ? { content } : {}) } };
}

export interface WorkflowVerification { path: string; expected: Row; created?: boolean; absentId?: unknown; remaining?: Row[]; tag?: { path: string; before: unknown }; content?: { base: string; ref: string; expected: unknown } }

function treeEntries(value: unknown) {
  if (!Array.isArray(value)) throw new CliError('INVALID_RESPONSE', 'Expected a complete Git tree');
  return value.map(item => { const row = object(item); return { path: row.path, mode: row.mode, type: row.type, sha: row.sha }; }).sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

export async function verifyWorkflow(client: Client, plan: WritePlan, results: unknown[], observations: { path: string; data: unknown }[]) {
  const verification = plan.workflow!;
  const mismatch = (): never => { throw new CliError('READBACK_MISMATCH', 'Readback did not confirm the selected identity and requested fields'); };
  const data = observations.find(row => row.path === verification.path)?.data;
  if (verification.absentId !== undefined) {
    if (!Array.isArray(data) || data.some(value => object(value).id === verification.absentId || object(value).tag_name === verification.expected.tag_name)) mismatch();
    const rows = data as Row[];
    if (rows.length !== verification.remaining!.length || verification.remaining!.some(row => JSON.stringify(rows.find(item => item.id === row.id)) !== JSON.stringify(row))) mismatch();
    const tags = observations.find(row => row.path === verification.tag!.path)?.data;
    if (!Array.isArray(tags) || JSON.stringify(tags.find(row => object(row).name === verification.expected.tag_name) ?? null) !== JSON.stringify(verification.tag!.before)) mismatch();
    return;
  }
  const actual = object(Array.isArray(data) ? data.find(row => object(row).tag_name === verification.expected.tag_name) : data);
  const matches = (actual: Row, expected: Row): boolean => Object.entries(expected).every(([key, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? matches(object(actual[key]), object(value)) : JSON.stringify(actual[key]) === JSON.stringify(value));
  if (!matches(actual, verification.expected)) mismatch();
  if (verification.created && (actual.id !== object(results[0]).id || !Number.isSafeInteger(actual.id) || Number(actual.id) <= 0)) mismatch();
  if (verification.content) {
    const commit = await resolveCommit(client, verification.content.base, verification.content.ref);
    const tree = object(await read(client, verification.content.base + '/git/trees/' + commit.sha + '?recursive=true'));
    if (tree.truncated !== false || JSON.stringify(treeEntries(tree.tree)) !== JSON.stringify(verification.content.expected)) mismatch();
  }
}
