import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalPath, collect, effectFor, object, read, validatePayload } from './api.js';
import type { Row } from './api.js';
import { CliError } from './error.js';
import { readPrivateFile, writePrivateFile } from './private-file.js';
import type { Options } from './reads.js';
import type { Client } from './transport.js';

export interface WriteStep { method: string; path: string; payload?: unknown }
export interface WritePlan { target: string; steps: WriteStep[]; reads: string[]; preconditions: unknown; named?: boolean }
interface Observation { path: string; data: unknown }
interface Receipt { binding: string; origin: string; reads: string[]; states: string[]; operations: string[]; attempt: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const usage = (message: string): never => { throw new CliError('USAGE', message, 2); };
const logPath = () => process.env.GITEA_AXI_WRITE_LOG ?? join(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? homedir() : process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'gitea-axi', 'writes.log');
const directory = () => join(dirname(logPath()), 'write-receipts');
const command = (id: string, options: Options) => 'gitea-axi write reconcile ' + id +
  (options.config ? ' --config ' + shell(String(options.config)) : '') + (options.profile ? ' --profile ' + shell(String(options.profile)) : '') +
  (options.origin ? ' --origin ' + shell(String(options.origin)) : '') + (options['allow-insecure-http'] ? ' --allow-insecure-http' : '');
function shell(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

async function key(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'key');
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32).toString('hex')); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return readPrivateFile(path, true);
}

export async function reconcile(client: Client, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) usage('Select the exact confirmation ID');
  const receipt: Receipt = JSON.parse(await readPrivateFile(join(directory(), id + '.json'), true));
  if (receipt.origin !== client.origin) throw new CliError('CONFIRMATION_MISMATCH', 'Reconciliation origin differs from the attempted write');
  const observations = await observe(client, receipt.reads);
  return { confirmation: id, operations: receipt.operations, states: receipt.states, observations,
    help: 'Inspect the exact identity and requested fields in these reads before authorizing any new attempt' };
}

async function observe(client: Client, paths: string[]) {
  const observations = [];
  for (const path of paths) {
    const data = await read(client, path);
    if (Array.isArray(data)) {
      const page = await collect(client, path);
      if (page.truncated) throw new CliError('INCOMPLETE_READ', 'Reconciliation requires a complete collection');
      observations.push({ path, data: page.items });
    } else observations.push({ path, data });
  }
  return observations;
}

function verifyNamed(plan: WritePlan, results: unknown[], observations: Observation[]) {
  const mismatch = (): never => { throw new CliError('READBACK_MISMATCH', 'Verification did not confirm the requested fields'); };
  const collection = (path: string): Row[] => {
    const data = observations.find(row => row.path.split('?')[0] === path)?.data;
    if (!Array.isArray(data)) return mismatch();
    return data.map(object);
  };
  const before = object(plan.preconditions);
  const issueFields = (issue: Row) => ({
    title: issue.title, body: issue.body ?? '', state: issue.state,
    assignees: ((issue.assignees ?? []) as unknown[]).map(row => object(row).login).sort(),
    labels: ((issue.labels ?? []) as unknown[]).map(row => object(row).id).sort(),
    milestone: issue.milestone == null ? null : object(issue.milestone).id,
  });
  const expectedIssues = new Map<string, Row>();
  for (const [path, value] of Object.entries(before)) {
    if (/\/issues\/\d+$/.test(path) && !plan.steps.some(step => step.path === path && step.method === 'DELETE')) {
      const issue = object(value);
      expectedIssues.set(path, { id: issue.id, number: issue.number, ...issueFields(issue) });
    }
  }
  for (const [index, step] of plan.steps.entries()) {
    if (/\/issues$/.test(step.path) && step.method === 'POST') {
      const result = object(results[index]);
      const actual = collection(step.path).find(row => row.id === result.id && row.number === result.number);
      if (!actual || (before[step.path + '?state=all&type=issues'] as Row[]).some(row => row.id === result.id || row.number === result.number)) mismatch();
      const expected = { title: '', body: '', state: 'open', assignees: [], labels: [], milestone: null, ...object(step.payload) };
      expected.assignees = [...expected.assignees].sort();
      expected.labels = [...expected.labels].sort();
      if (canonical(issueFields(actual!)) !== canonical(expected)) mismatch();
    }
    const expected = expectedIssues.get(step.path);
    if (expected && step.method === 'PATCH') Object.assign(expected, object(step.payload));
    const membership = /^(.*\/issues\/\d+)\/labels(?:\/(\d+))?$/.exec(step.path);
    if (membership) {
      const issue = expectedIssues.get(membership[1]!)!;
      const ids = new Set(issue.labels as unknown[]);
      if (step.method === 'POST') for (const id of object(step.payload).labels as unknown[]) ids.add(id);
      else for (const id of ids) if (String(id) === membership[2]) ids.delete(id);
      issue.labels = [...ids];
    }
  }
  for (const [path, expected] of expectedIssues) {
    const actual = object(observations.find(row => row.path === path)?.data);
    const { id, number, ...fields } = expected;
    fields.assignees = [...fields.assignees as unknown[]].sort();
    fields.labels = [...fields.labels as unknown[]].sort();
    if (actual.id !== id || actual.number !== number || canonical(issueFields(actual)) !== canonical(fields)) mismatch();
  }
  for (const [index, step] of plan.steps.entries()) {
    const pin = /^(.*\/issues)\/(\d+)\/pin$/.exec(step.path);
    if (pin) {
      const pins = collection(pin[1] + '/pinned');
      const expected = new Set((object(plan.preconditions)[pin[1] + '/pinned'] as Row[]).map(row => String(row.number)));
      if (step.method === 'POST') expected.add(pin[2]!); else expected.delete(pin[2]!);
      if (canonical(pins.map(row => String(row.number)).sort()) !== canonical([...expected].sort())) mismatch();
      continue;
    }
    const membership = /^(.*\/issues\/\d+)\/labels(?:\/(\d+))?$/.exec(step.path);
    if (membership) continue;
    const deletion = /^(.*\/(?:issues|labels))\/(\d+)$/.exec(step.path);
    if (step.method === 'DELETE' && deletion) {
      const field = deletion[1]!.endsWith('/issues') ? 'number' : 'id';
      const actual = collection(deletion[1]!);
      const previous = Object.entries(before).find(([path]) => path.split('?')[0] === deletion[1])?.[1] as Row[];
      const remaining = previous.filter(row => String(row[field]) !== deletion[2]);
      if (actual.some(row => String(row[field]) === deletion[2]) || actual.length !== remaining.length ||
          remaining.some(row => canonical(actual.find(item => item.id === row.id)) !== canonical(row))) mismatch();
      continue;
    }
    if (/\/issues(?:\/\d+)?$/.test(step.path)) continue;
    const result = object(results[index]);
    const listPath = step.method === 'POST' ? step.path : step.path.replace(/\/\d+$/, '');
    const id = step.method === 'PATCH' ? (before[listPath] as Row[]).find(row => String(row.id) === step.path.split('/').at(-1))!.id : result.id;
    const actual = collection(listPath).find(row => row.id === id);
    if (!actual || actual.id !== id) { mismatch(); continue; }
    for (const [field, value] of Object.entries(object(step.payload))) {
      if (canonical(actual[field]) !== canonical(value)) mismatch();
    }
  }
}

export async function write(client: Client, identity: { writes?: { allowWrites: boolean; operations: string[] } | undefined }, plan: WritePlan, options: Options) {
  if (process.env.GITEA_AXI_READ_ONLY !== undefined && process.env.GITEA_AXI_READ_ONLY !== 'false') throw new CliError('READ_ONLY', 'Host or native read-only policy refuses writes');
  if (Boolean(options.preview) === Boolean(options.confirm)) usage('Choose exactly --preview or --confirm <confirmation>');
  const routes = plan.steps.map(step => validatePayload(step.method, step.path, step.payload));
  const operations = routes.map(route => route.operation);
  const allowed = String(options['allow-write'] ?? '').split(',');
  const hosted = process.env.GITEA_AXI_HOST_WRITE_OPERATIONS;
  for (const operation of operations) {
    if (!allowed.includes(operation) || (hosted !== undefined && !hosted.split(',').includes(operation)) ||
        (identity.writes && (!identity.writes.allowWrites || !identity.writes.operations.includes(operation)))) {
      throw new CliError('READ_ONLY', 'Write policy must explicitly allow ' + operation);
    }
  }
  if (!isAbsolute(logPath())) usage('GITEA_AXI_WRITE_LOG must be absolute');
  const root = directory();
  const secret = await key(root);
  const binding = createHmac('sha256', secret).update(canonical({ identity, revision: process.env.GITEA_AXI_CREDENTIAL_REVISION, origin: client.origin, plan })).digest('hex');
  // Exclude credential revision and preconditions from the attempt key so rotating a credential
  // or changing the remote record cannot bypass an unresolved dispatched effect.
  const effectSteps = plan.steps.map((step, index) => {
    const route = routes[index]!;
    const segments = canonicalPath(step.path).split('/');
    if (/\{(?:template_)?repo\}/.test(route.path)) {
      for (const [index, segment] of route.path.split('/').entries()) {
        if (/^\{(?:owner|repo|org|template_owner|template_repo)\}$/.test(segment)) {
          segments[index] = encodeURIComponent(decodeURIComponent(segments[index]!).toLowerCase());
        }
      }
    }
    return { ...step, path: segments.join('/') };
  });
  const attempt = digest({ origin: client.origin, steps: effectSteps });
  const guards = [...new Set(effectSteps.map(step => join(root, digest({ origin: client.origin, step }) + '.attempt')))];
  for (const guard of guards) {
    if (existsSync(guard)) {
      const previous = await readPrivateFile(guard, true);
      throw new CliError('WRITE_OUTCOME_UNKNOWN', 'An attempt already exists; reconcile with ' + command(previous, options));
    }
  }
  if (options.preview) {
    const id = randomUUID();
    const receipt: Receipt = { binding, origin: client.origin, reads: plan.reads, states: plan.steps.map(() => 'pending'), operations, attempt };
    await writePrivateFile(join(root, id + '.json'), JSON.stringify(receipt));
    return { confirmation: id, origin: client.origin, target: plan.target, operations, steps: plan.steps, preconditions: plan.preconditions,
      help: 'Repeat the same command with --confirm ' + id + ' instead of --preview' };
  }
  const id = String(options.confirm);
  if (!/^[a-f0-9-]{36}$/.test(id)) usage('Use the confirmation ID returned by --preview');
  const path = join(root, id + '.json');
  const receipt: Receipt = JSON.parse(await readPrivateFile(path, true));
  if (receipt.states.some(state => state !== 'pending')) throw new CliError('WRITE_OUTCOME_UNKNOWN', 'Confirmation was already dispatched; reconcile with ' + command(id, options));
  if (receipt.binding !== binding) throw new CliError('CONFIRMATION_MISMATCH', 'Credential revision, origin, target, operation, payload or preconditions changed; preview again');
  const reserved: string[] = [];
  for (const guard of guards) {
    try {
      const file = await open(guard, 'wx', 0o600);
      reserved.push(guard);
      try { await file.writeFile(id); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      await Promise.all(reserved.map(path => rm(path)));
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new CliError('WRITE_OUTCOME_UNKNOWN', 'Concurrent attempt refused; reconcile with ' + command(await readPrivateFile(guard, true), options));
      }
      throw error;
    }
  }
  const results: unknown[] = [];
  for (const [index, step] of plan.steps.entries()) {
    receipt.states[index] = 'dispatched';
    await writePrivateFile(path, JSON.stringify(receipt));
    const journal = await open(logPath(), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await journal.stat();
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new CliError('CONFIG_INSECURE', 'Write journal must be an owned private file');
      await journal.writeFile(JSON.stringify({ confirmation: id, operation: operations[index], attempt, step: index, state: 'dispatched' }) + '\n');
      await journal.sync();
    } finally { await journal.close(); }
    try {
      results.push((await client.request(step.path, false, step)).data);
      receipt.states[index] = 'completed';
      await writePrivateFile(path, JSON.stringify(receipt));
    } catch {
      throw new CliError('WRITE_OUTCOME_UNKNOWN', 'Write may have applied; steps=' + receipt.states.join(',') + '; reconcile with ' + command(id, options));
    }
  }
  let observations;
  try {
    observations = await observe(client, plan.reads);
    if (plan.named) verifyNamed(plan, results, observations);
  }
  catch { throw new CliError('WRITE_OUTCOME_UNKNOWN', 'Write dispatched but verification failed; reconcile with ' + command(id, options)); }
  await Promise.all(guards.map(path => rm(path)));
  return { confirmation: id, states: receipt.states, results, observations, reconcile: command(id, options) };
}

export async function rawWritePlan(client: Client, method: string, path: string, payload: unknown): Promise<WritePlan> {
  const route = validatePayload(method, path, payload);
  let verification = path.split('?')[0]!;
  if (method === 'DELETE' || route.operation === 'repoMergePullRequest') verification = verification.slice(0, verification.lastIndexOf('/'));
  while (!effectFor('GET', verification) || effectFor('GET', verification)?.effect !== 'read') {
    verification = verification.slice(0, verification.lastIndexOf('/'));
    if (!verification.startsWith('/api/v1/')) usage('No metadata reconciliation read is available for this route');
  }
  if (verification.endsWith('/issues')) verification += '?state=all&type=issues';
  const preconditions = await observe(client, [verification]);
  return { target: path, steps: [{ method, path, ...(payload === undefined ? {} : { payload }) }], reads: [verification], preconditions };
}

const names = (value: unknown): string[] => [...new Set(Array.isArray(value) ? value.map(String) : [String(value)])];
export async function issueLabelPlan(client: Client, operation: string, base: string, number: string | undefined, options: Options): Promise<WritePlan> {
  const [kind, action] = operation.split(' ');
  const steps: WriteStep[] = [];
  const reads = new Set<string>();
  const preconditions: Row = {};
  const snapshot = async (path: string) => {
    const data = await read(client, path);
    preconditions[path] = data; reads.add(path); return data;
  };
  const fullList = async (path: string) => {
    const page = await collect(client, path);
    if (page.truncated) throw new CliError('INCOMPLETE_READ', 'A complete collection is required before writing');
    preconditions[path] = page.items; reads.add(path); return page.items;
  };
  const add = (method: string, path: string, payload?: unknown) => steps.push({ method, path, ...(payload === undefined ? {} : { payload }) });
  if (kind === 'label') {
    const labels = await fullList(base + '/labels');
    const selected = action === 'create' ? undefined : labels.find(label => label.name === number || String(label.id) === number);
    if (action !== 'create' && !selected) usage('Select an existing exact label name or ID');
    if (action === 'delete' && labels.length < 2) usage('Deletion requires a remaining control label');
    const path = base + '/labels' + (selected ? '/' + selected.id : '');
    const payload: Row = {};
    if (options.name !== undefined) payload.name = options.name;
    if (action === 'create' && !payload.name) usage('--name is required');
    if (options.description !== undefined) payload.description = options.description;
    if (options.color !== undefined) {
      const color = String(options.color).replace(/^#/, '').toLowerCase();
      if (!/^[a-f0-9]{6}$/.test(color)) usage('--color requires six hexadecimal digits');
      payload.color = color;
    }
    if (action === 'create' && !payload.color) usage('--color is required');
    if (action === 'edit' && !Object.keys(payload).length) usage('Choose a label field to edit');
    add(action === 'delete' ? 'DELETE' : action === 'create' ? 'POST' : 'PATCH', path, action === 'delete' ? undefined : payload);
  } else {
    const path = base + '/issues' + (number ? '/' + number : '');
    if (number) await snapshot(path);
    else await fullList(base + '/issues?state=all&type=issues');
    if (action === 'create' || action === 'edit') {
      const payload: Row = {};
      for (const field of ['title', 'body']) if (options[field] !== undefined) payload[field] = options[field];
      if (action === 'create' && !payload.title) usage('--title is required');
      if (options.assignee !== undefined) payload.assignees = names(options.assignee);
      if (options['add-assignee'] !== undefined || options['remove-assignee'] !== undefined) {
        const assignees = new Set((object(preconditions[path]).assignees as unknown[] ?? []).map(value => String(object(value).login)));
        if (options['add-assignee'] !== undefined) for (const name of names(options['add-assignee'])) assignees.add(name);
        if (options['remove-assignee'] !== undefined) for (const name of names(options['remove-assignee'])) assignees.delete(name);
        payload.assignees = [...assignees];
      }
      if (options.milestone !== undefined) {
        const milestones = await fullList(base + '/milestones?state=all');
        const milestone = milestones.find(row => row.title === options.milestone);
        if (!milestone) return usage('Unknown exact milestone title');
        payload.milestone = milestone.id;
      }
      const labelIds = async (value: unknown) => {
        const labels = await fullList(base + '/labels');
        return names(value).map(name => {
          const label = labels.find(row => row.name === name);
          if (!label) return usage('Unknown exact label name: ' + name);
          return label.id;
        });
      };
      if (options.label !== undefined) payload.labels = await labelIds(options.label);
      if (options['add-label'] !== undefined) add('POST', path + '/labels', { labels: await labelIds(options['add-label']) });
      if (options['remove-label'] !== undefined) {
        await snapshot(path + '/labels');
        for (const id of await labelIds(options['remove-label'])) add('DELETE', path + '/labels/' + id);
      }
      if (Object.keys(payload).length) steps.unshift({ method: action === 'create' ? 'POST' : 'PATCH', path, payload });
      if (!steps.length) usage('Choose an issue field to edit');
    } else if (action === 'close' || action === 'reopen') {
      add('PATCH', path, { state: action === 'close' ? 'closed' : 'open' });
      if (options.comment !== undefined) {
        await snapshot(path + '/comments');
        add('POST', path + '/comments', { body: options.comment });
      }
    } else if (action === 'comment') {
      if (!options.body) usage('--body is required');
      await snapshot(path + '/comments'); add('POST', path + '/comments', { body: options.body });
    } else if (action === 'delete') {
      const issues = await fullList(base + '/issues?state=all&type=issues');
      if (!issues.some(issue => String(issue.number) !== number)) usage('Deletion requires a remaining control issue');
      add('DELETE', path);
      reads.delete(path);
    } else {
      await fullList(base + '/issues/pinned');
      add(action === 'pin' ? 'POST' : 'DELETE', path + '/pin');
    }
  }
  return { target: base + '/' + kind + (number ? '/' + number : ''), steps, reads: [...reads], preconditions, named: true };
}
