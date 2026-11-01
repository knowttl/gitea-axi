import { existsSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Git } from './git.js';
import { CliError } from './error.js';
import { collect, object, read, resolveCommit } from './api.js';
import { repoPath, repositoryPlan, validateRepositoryWorkflow } from './repo-workflows.js';
import { verifyPull } from './pulls.js';
import { readPrivateFile, writePrivateFile } from './private-file.js';
import { write } from './writes.js';
import type { WritePlan } from './writes.js';
import type { Options } from './reads.js';
import type { Client } from './transport.js';
import { stackWorkflow } from './stacks.js';

export interface LocalIdentity { origin: string; token?: string | undefined; writes?: { allowWrites: boolean; operations: string[] } | undefined }
export const usage = (message: string): never => { throw new CliError('USAGE', message, 2); };
export const gap = (message: string): never => { throw new CliError('CAPABILITY_GAP', message); };
export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function isLocal(operation: string, options: Options) {
  return operation.startsWith('stack ') || ['repo clone', 'pr checkout', 'pr revert'].includes(operation) ||
    ['repo create', 'repo fork'].includes(operation) && ['source', 'push', 'remote', 'clone', 'workspace'].some(key => options[key] !== undefined);
}

export function validateLocal(operation: string, options: Options) {
  if (process.env.GITEA_AXI_HOST_WRITE_OPERATIONS !== undefined || process.env.GITEA_AXI_CREDENTIAL_REVISION !== undefined) {
    throw new CliError('READ_ONLY', 'Workspace workflows are standalone only');
  }
  if (operation.startsWith('stack ') && (options.repo || process.env.GH_REPO)) usage('Stack commands reject -R/--repo and GH_REPO; use the explicit local workspace');
  if (typeof options.workspace !== 'string' || !isAbsolute(options.workspace)) usage('--workspace requires an explicit absolute path');
  if (options.config !== undefined && !isAbsolute(String(options.config))) usage('--config must be absolute');
}

export async function localEffect(client: Client, identity: LocalIdentity, operation: string, options: Options, git: Git,
  preconditions: unknown, payload: unknown, execute: () => Promise<unknown>, api?: WritePlan) {
  const step = { method: 'LOCAL', path: git.cwd, local: 'gitea.local.' + operation, payload };
  const plan: WritePlan = api ? { ...api, steps: [...api.steps, step], preconditions: { api: api.preconditions, workspace: preconditions } } :
    { target: git.cwd, steps: [step], reads: [], preconditions };
  // Keep API verification preconditions in their original shape for the existing verifier.
  if (api) plan.preconditions = { ...object(api.preconditions), localWorkspace: preconditions };
  return write(client, identity, plan, options, execute);
}

export async function localWorkflow(client: Client, identity: LocalIdentity, operation: string, args: string[], options: Options) {
  if (operation.startsWith('stack ')) return stackWorkflow(client, identity, operation.slice(6), args, options);
  const workspace = await realpath(String(options.workspace));
  const git = new Git(workspace, identity.origin, identity.token);
  if (operation === 'repo clone') {
    if (args.length !== 1) usage('Select one OWNER/NAME to clone');
    const name = args[0]!;
    const url = git.url(name);
    const destination = join(workspace, name.split('/')[1]!);
    if (existsSync(destination)) usage('Clone destination already exists');
    const repo = object(await read(client, repoPath(name)));
    if (repo.full_name !== name) throw new CliError('INVALID_RESPONSE', 'Repository identity differs from the selected clone target');
    const expected = await resolveCommit(client, repoPath(name), String(repo.default_branch));
    const preconditions = { parent: workspace, contents: await readdir(workspace), repository: repo, commit: expected.sha };
    return localEffect(client, identity, 'clone', options, git, preconditions, { url, destination }, async () => {
      if (existsSync(destination) || !same(await readdir(workspace), preconditions.contents)) throw new CliError('CONFIRMATION_MISMATCH', 'Clone parent changed');
      await git.run(['clone', '--no-checkout', '--', url, destination]);
      const clone = await new Git(destination, identity.origin, identity.token).workspace();
      await clone.run(['checkout', '--detach', String(expected.sha)]);
      if (await clone.tip() !== expected.sha) throw new CliError('READBACK_MISMATCH', 'Clone head differs from the previewed default commit');
      return { workspace: destination, head: expected.sha, remote: await clone.remote('origin') };
    });
  }
  if (operation === 'repo create' || operation === 'repo fork') {
    if (args.length > 1) usage('Select at most one repository');
    if (operation === 'repo create' && (options.push || options.remote) && !options.source || options.push && !options.source) usage('--push and repository creation --remote require --source');
    if (options.source && options.clone) usage('Choose --source or --clone');
    const apiOptions = { ...options };
    for (const key of ['source', 'push', 'remote', 'clone', 'workspace']) delete apiOptions[key];
    validateRepositoryWorkflow(operation, apiOptions);
    const api = await repositoryPlan(client, operation, args[0], apiOptions);
    const destinationName = String(api.workflow!.expected.full_name);
    const url = git.url(destinationName);
    let source: Git | undefined;
    let preconditions: unknown;
    const remote = String(options.remote ?? 'origin');
    if (!/^[A-Za-z0-9_-]+$/.test(remote)) usage('Select a simple remote name');
    const destination = join(workspace, destinationName.split('/')[1]!);
    if (options.source || operation === 'repo fork' && options.remote && !options.clone) {
      const sourcePath = String(options.source ?? workspace);
      if (!isAbsolute(sourcePath)) usage('--source requires an absolute native repository root');
      source = await new Git(await realpath(sourcePath), identity.origin, identity.token).workspace();
      if (source.cwd !== workspace) usage('--source must equal the explicit --workspace');
      await source.clean();
      if (options.push && !await source.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])) usage('Publishing requires a named source branch');
      if ((await source.run(['remote'])).split('\n').includes(remote)) usage('Selected remote already exists; choose another --remote');
      preconditions = await source.snapshot();
    } else if (options.clone) {
      if (existsSync(destination)) usage('Clone destination already exists');
      preconditions = { parent: workspace, contents: await readdir(workspace) };
    } else usage('Workspace composite requires --source or --clone');
    return localEffect(client, identity, 'composite', options, git, preconditions,
      { source: source?.cwd, remote, url, clone: Boolean(options.clone), push: Boolean(options.push) }, async () => {
        if (source) {
          if (!same(await source.snapshot(), preconditions)) throw new CliError('CONFIRMATION_MISMATCH', 'Source changed after API creation; repository created, local publication stopped');
          await source.run(['remote', 'add', remote, url]);
          if (options.push) {
            const branch = await source.run(['symbolic-ref', '--short', 'HEAD']);
            await source.run(['push', '--', url, 'refs/heads/' + branch + ':refs/heads/' + branch]);
            if (!(await source.run(['ls-remote', '--', url, 'refs/heads/' + branch])).startsWith(await source.tip())) throw new CliError('READBACK_MISMATCH', 'Published head was not confirmed');
          }
          return { workspace, remote, published: Boolean(options.push), head: await source.tip() };
        }
        if (existsSync(destination)) throw new CliError('CONFIRMATION_MISMATCH', 'Clone destination appeared; API repository was created');
        await git.run(['clone', '--origin', remote, '--', url, destination]);
        return { workspace: destination, remote };
      }, api);
  }
  await git.workspace();
  await git.clean();
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]!)) usage('Select one positive PR number');
  const remote = await git.remote('origin');
  if (options.repo && options.repo !== remote.repository) usage('--repo must match the workspace origin remote');
  const base = repoPath(remote.repository);
  const pull = object(await read(client, base + '/pulls/' + args[0]));
  const snapshot = await git.snapshot();
  if (operation === 'pr checkout') {
    const head = object(pull.head);
    const headRepository = object(head.repo);
    const url = git.url(String(headRepository.full_name));
    if (!/^[a-f0-9]{40}$/.test(String(head.sha))) throw new CliError('INVALID_RESPONSE', 'PR head requires an exact commit SHA');
    await git.branch(String(head.ref));
    return localEffect(client, identity, 'checkout', options, git, { snapshot, pull, remote }, { url, ref: head.ref, sha: head.sha }, async () => {
      if (!same(snapshot, await git.snapshot())) throw new CliError('CONFIRMATION_MISMATCH', 'Workspace changed');
      await git.run(['fetch', '--no-tags', '--', url, 'refs/heads/' + head.ref]);
      if (await git.tip('FETCH_HEAD') !== head.sha) throw new CliError('STALE_HEAD', 'Fetched PR branch differs from the previewed head; checkout stopped');
      await git.run(['checkout', '--detach', String(head.sha)]);
      return { workspace, head: await git.tip() };
    });
  }
  if (pull.merged !== true || !/^[a-f0-9]{40}$/.test(String(pull.merge_commit_sha))) usage('Revert requires a merged PR with an exact merge commit');
  const branch = 'revert-' + args[0] + '-' + String(pull.merge_commit_sha).slice(0, 12);
  const baseBranch = await git.branch(String(object(pull.base).ref));
  const recordPath = join(await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'gitea-axi', branch + '.json');
  if ((await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/' + branch])) === branch) {
    if (snapshot.branch !== branch) usage('Check out the generated revert branch before previewing its publication');
    if (!existsSync(recordPath)) usage('The branch has no recorded revert provenance; inspect the existing branch before publication');
    const record = object(await load(recordPath));
    if (record.merge !== pull.merge_commit_sha || record.head !== snapshot.head || record.repository !== remote.repository || record.origin !== identity.origin) {
      throw new CliError('CONFIRMATION_MISMATCH', 'The generated revert branch or its origin-bound provenance changed');
    }
    const pulls = await collect(client, base + '/pulls?state=all');
    if (pulls.truncated) throw new CliError('INCOMPLETE_READ', 'Revert publication requires a complete PR collection');
    if (pulls.items.some(item => object(item.head).ref === branch)) usage('The revert branch already has a PR; inspect it before repeating');
    const payload = { title: 'Revert "' + String(pull.title) + '"', body: 'Reverts #' + args[0], head: branch, base: baseBranch };
    const local = { method: 'LOCAL', path: workspace, local: 'gitea.local.revert' };
    const plan: WritePlan = { target: base + '/pulls', reads: [],
      preconditions: { snapshot, pull, remote, pulls: pulls.items },
      steps: [{ ...local, payload: { phase: 'push', branch, sha: snapshot.head } },
        { method: 'POST', path: base + '/pulls', payload }, { ...local, payload: { phase: 'verify', payload } }] };
    return write(client, identity, plan, options, async (step, results) => {
      if (object(step.payload).phase === 'push') {
        if (!same(snapshot, await git.snapshot())) throw new CliError('CONFIRMATION_MISMATCH', 'Revert branch changed');
        await git.run(['push', '--', remote.url, 'refs/heads/' + branch + ':refs/heads/' + branch]);
        return { branch, head: snapshot.head };
      }
      const created = object(results[1]);
      const actual = object(await read(client, base + '/pulls/' + created.number));
      if (actual.id !== created.id || object(actual.head).sha !== snapshot.head || object(actual.head).ref !== branch ||
          object(actual.base).ref !== baseBranch || actual.title !== payload.title || actual.body !== payload.body) {
        throw new CliError('READBACK_MISMATCH', 'Revert PR did not confirm its exact branch and generated commit');
      }
      return { pull: actual, branch, head: snapshot.head };
    });
  }
  const preconditions = { snapshot, pull, remote };
  return localEffect(client, identity, 'revert', options, git, preconditions, { branch, baseBranch, merge: pull.merge_commit_sha }, async () => {
    await git.run(['fetch', '--no-tags', '--', remote.url, 'refs/heads/' + baseBranch]);
    await git.run(['checkout', '-b', branch, 'FETCH_HEAD']);
    const parents = (await git.run(['rev-list', '--parents', '-n', '1', String(pull.merge_commit_sha)])).split(' ');
    if (parents.length !== 3) gap('Revert currently requires a two-parent merge commit; branch retained without a revert');
    await git.run(['revert', '--no-edit', '-m', '1', String(pull.merge_commit_sha)]);
    await save(recordPath, { merge: pull.merge_commit_sha, head: await git.tip(), repository: remote.repository, origin: identity.origin });
    return { branch, head: await git.tip(), state: 'local revert prepared',
      next: 'Repeat pr revert ' + args[0] + ' with --preview to bind publication of the generated commit and creation of its revert PR' };
  });
}

export async function lock(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'lock');
  const file = await open(path, 'wx', 0o600).catch(() => { throw new CliError('STACK_LOCKED', 'Stack mutation is locked; inspect the owning process before manual recovery'); });
  return async () => { await file.close(); await rm(path); };
}

export async function verifyPlannedPull(client: Client, plan: WritePlan, result: unknown) {
  const observations = [];
  for (const path of plan.reads) observations.push({ path, data: await read(client, path) });
  await verifyPull(client, plan, [result], observations);
}

export async function save(path: string, value: unknown) { await writePrivateFile(path, JSON.stringify(value)); }
export async function load(path: string): Promise<unknown> { return JSON.parse(await readPrivateFile(path, true, 1_000_000)) as unknown; }
