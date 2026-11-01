import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { Git } from './git.js';
import { CliError } from './error.js';
import { collect, object, read } from './api.js';
import { repoPath } from './repo-workflows.js';
import { pullPlan } from './pulls.js';
import { gap, load, lock, same, save, usage, verifyPlannedPull } from './local-workflows.js';
import type { LocalIdentity } from './local-workflows.js';
import type { Options } from './reads.js';
import type { WritePlan, WriteStep } from './writes.js';
import { write } from './writes.js';
import type { Client } from './transport.js';

interface Pull { branch: string; number: number; base: string; head: string; state: 'open' | 'closed'; merged: boolean }
interface Rebase {
  branches: string[]; oldBases: Record<string, string>; originalTips: Record<string, string>;
  expectedTips: Record<string, string>; originalBranch: string; cursor: number; dispatched: boolean; authorDate: boolean;
}
interface Stack {
  version: 1; revision: number; id: string; trunk: string; branches: string[]; remote: string; origin: string; repository: string;
  pulls: Pull[]; pending?: { action: string; confirmations: string[]; originalBranch: string; originalTips: string;
    steps: { effect: string; state: 'pending' | 'dispatched' | 'completed' }[]; rebase?: Rebase };
}
const branch = { type: 'string', minLength: 1 };
const tips = { type: 'object', additionalProperties: { type: 'string', pattern: '^[a-f0-9]{40}$' } };
const schema = new Ajv().compile<Stack>({
  type: 'object', additionalProperties: false, required: ['version', 'revision', 'id', 'trunk', 'branches', 'remote', 'origin', 'repository', 'pulls'],
  properties: {
    version: { const: 1 }, revision: { type: 'integer', minimum: 0 }, id: branch, trunk: branch,
    branches: { type: 'array', uniqueItems: true, items: branch }, remote: branch, origin: branch, repository: branch,
    pulls: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['branch', 'number', 'base', 'head', 'state', 'merged'],
      properties: { branch, number: { type: 'integer', minimum: 1 }, base: branch, head: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        state: { enum: ['open', 'closed'] }, merged: { type: 'boolean' } } } },
    pending: { type: 'object', additionalProperties: false, required: ['action', 'confirmations', 'originalBranch', 'originalTips', 'steps'], properties: { action: branch,
      confirmations: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
      originalBranch: { type: 'string' }, originalTips: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['effect', 'state'],
        properties: { effect: branch, state: { enum: ['pending', 'dispatched', 'completed'] } } } },
      rebase: { type: 'object', additionalProperties: false,
        required: ['branches', 'oldBases', 'originalTips', 'expectedTips', 'originalBranch', 'cursor', 'dispatched', 'authorDate'],
        properties: { branches: { type: 'array', items: branch, uniqueItems: true }, oldBases: tips, originalTips: tips, expectedTips: tips,
          originalBranch: branch, cursor: { type: 'integer', minimum: 0 }, dispatched: { type: 'boolean' }, authorDate: { type: 'boolean' } } } } },
  },
});

async function stackAt(path: string, git: Git): Promise<Stack | undefined> {
  if (!existsSync(path)) return undefined;
  const value = await load(path);
  if (!schema(value) || value.origin !== git.origin || value.branches.includes(value.trunk) ||
      new Set(value.pulls.map(pull => pull.branch)).size !== value.pulls.length ||
      value.pulls.some(pull => !value.branches.includes(pull.branch))) {
    throw new CliError('STACK_INVALID', 'Stack metadata is invalid, inconsistent or belongs to a different origin');
  }
  const rebase = value.pending?.rebase;
  if (rebase) {
    if (rebase.cursor > rebase.branches.length || rebase.branches.some(branch => !value.branches.includes(branch) || !rebase.oldBases[branch]) ||
        Object.keys(rebase.oldBases).length !== rebase.branches.length ||
        [rebase.originalTips, rebase.expectedTips].some(tips => Object.keys(tips).length !== value.branches.length || value.branches.some(branch => !Object.hasOwn(tips, branch)))) {
      throw new CliError('STACK_INVALID', 'Rebase checkpoints must describe only the owned stack branches');
    }
    await git.branch(rebase.originalBranch);
  }
  for (const name of [value.trunk, ...value.branches]) await git.branch(name);
  return value;
}

async function ancestor(git: Git, parent: string, child: string) {
  return (await git.run(['merge-base', parent, child])) === await git.tip(parent);
}

export async function stackWorkflow(client: Client, identity: LocalIdentity, action: string, args: string[], options: Options) {
  const git = await new Git(String(options.workspace), identity.origin, identity.token).workspace();
  const directory = join(await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'gitea-axi');
  const path = join(directory, 'stacks.json');
  const before = await stackAt(path, git);
  const snapshot = await git.snapshot();
  if (action === 'view') {
    if (args.length) usage('stack view takes no positional arguments');
    return { stack: before ?? null, current: snapshot.branch, recovery: before?.pending ?? null };
  }
  if (action === 'submit') gap('Stack submit requires --auto scheduling; actual merge_when_checks_succeed scheduling is not verified, so no branch or PR was changed');
  if (options.all && options.update) usage('Choose --all or --update');
  if ((options.all || options.update) && !options.message) usage('--all and --update require --message');
  if (options.continue && options.abort) usage('Choose --continue or --abort');
  const recoveringRebase = action === 'rebase' && (options.continue || options.abort);
  const recoveringPush = action === 'sync' && before?.pending?.action === 'push';
  const recoveringSync = action === 'sync' && before?.pending?.action === 'sync';
  const recovering = recoveringRebase || recoveringPush || recoveringSync;
  if (recoveringRebase && (args.length || ['downstack', 'upstack', 'no-trunk', 'committer-date-is-author-date', 'remote'].some(key => options[key]))) usage('Recovery uses the recorded rebase options only');
  if (before?.pending && !recovering) throw new CliError('STACK_RECOVERY_REQUIRED', 'Stack operation is pending; inspect stack view and the native Git state before recovery');
  if (!recovering && !(action === 'add' && options.message)) await git.clean();
  if (!before && !['init', 'link'].includes(action)) usage('Initialize or link the stack first');
  const remote = await git.remote(String(options.remote ?? before?.remote ?? 'origin'));
  if (before && remote.repository !== before.repository) usage('Selected remote must address the recorded stack repository');
  const base = repoPath(remote.repository);
  const remoteRefs = ['push', 'sync', 'rebase'].includes(action) ? await git.run(['ls-remote', '--heads', '--', remote.url]) : '';
  if (recoveringPush) {
    if (before!.pending!.originalTips !== snapshot.refs || remote.name !== before!.remote) throw new CliError('STACK_RECOVERY_REQUIRED', 'Push recovery requires the recorded branch tips and remote');
    for (const name of before!.branches) {
      if (!remoteRefs.split('\n').includes(await git.tip('refs/heads/' + name) + '\trefs/heads/' + name)) {
        throw new CliError('STACK_RECOVERY_REQUIRED', 'Remote does not confirm the interrupted push; no effect repeated');
      }
    }
  }
  let state: Stack = before ? structuredClone(before) : { version: 1, revision: 0, id: '', trunk: '', branches: [],
    remote: remote.name, origin: identity.origin, repository: remote.repository, pulls: [] };
  state.remote = remote.name;
  const plans: WritePlan[] = [];
  const commands: string[][] = [];
  let destination: string | undefined;
  let remove = false;
  let rebase: Rebase | undefined;
  const apiPreconditions: unknown[] = [];
  const select = (selector: string) => {
    if (state.branches.includes(selector) || selector === state.trunk) return selector;
    if (selector === state.id) return state.branches[0]!;
    const url = /^https?:/.test(selector) ? new URL(selector) : undefined;
    if (url && (url.origin !== identity.origin || url.pathname.split('/').slice(1, 3).join('/') !== state.repository || url.search || url.hash || url.username || url.password)) usage('PR URL must belong to the stack repository');
    const number = url ? /^\/[^/]+\/[^/]+\/pulls\/([1-9]\d*)$/.exec(url.pathname)?.[1] : selector;
    return state.pulls.find(pull => String(pull.number) === number)?.branch ?? usage('Select an owned stack, branch or linked PR');
  };
  if (action === 'init' || action === 'link') {
    if (before && action === 'init') usage('A stack already exists; use stack add or unstack first');
    if (!args.length) usage('Select ordered existing branches or PR refs');
    state.trunk = await git.branch(String(options.base ?? before?.trunk ?? snapshot.branch));
    const branches: string[] = [];
    const pulls: Pull[] = [];
    for (const selector of args) {
      let name = selector;
      let number: string | undefined;
      if (action === 'link') {
        if (/^[1-9]\d*$/.test(selector)) number = selector;
        else if (/^https?:/.test(selector)) {
          const url = new URL(selector);
          if (url.origin !== identity.origin || url.username || url.password || url.search || url.hash ||
              !url.pathname.startsWith('/' + remote.repository + '/pulls/')) usage('Select PR URLs in the stack repository');
          number = url.pathname.split('/').at(-1);
          if (!/^[1-9]\d*$/.test(number ?? '')) usage('Select a positive PR number');
        }
        if (!number) {
          const page = await collect(client, base + '/pulls?state=open');
          if (page.truncated) throw new CliError('INCOMPLETE_READ', 'Link requires the complete PR collection');
          const matches = page.items.filter(pull => object(pull.head).ref === selector);
          if (matches.length !== 1) usage('Select a branch with exactly one open PR');
          number = String(matches[0]!.number);
        }
        const pull = object(await read(client, base + '/pulls/' + number));
        const head = object(pull.head);
        if (pull.state !== 'open' || object(head.repo).full_name !== remote.repository) usage('Link requires open same-repository PRs');
        name = String(head.ref);
        if (await git.tip('refs/heads/' + await git.branch(name)) !== head.sha) throw new CliError('STALE_HEAD', 'Local linked branch differs from its PR head');
        const parent = branches.at(-1) ?? state.trunk;
        const plan = await pullPlan(client, 'pr edit', base, number, { base: parent });
        plans.push(plan); apiPreconditions.push(plan.preconditions);
        pulls.push({ branch: name, number: Number(number), base: parent, head: String(head.sha), state: 'open', merged: false });
      }
      await git.branch(name);
      if (name === state.trunk || branches.includes(name)) usage('Stack branch membership must be unique and exclude trunk');
      const parent = branches.at(-1) ?? state.trunk;
      if (!await ancestor(git, 'refs/heads/' + parent, 'refs/heads/' + name)) usage('Branches must form the requested ancestor order');
      branches.push(name);
    }
    state = { ...state, id: branches[0]!, branches, pulls };
  } else if (action === 'add') {
    if (args.length > 1) usage('Select at most one existing branch');
    const name = await git.branch(args[0] ?? snapshot.branch);
    if (state.branches.includes(name) || name === state.trunk) usage('Select a branch outside the stack');
    if (options.message && name !== snapshot.branch) usage('Commit options require the current branch');
    if (!await ancestor(git, 'refs/heads/' + (state.branches.at(-1) ?? state.trunk), 'refs/heads/' + name)) usage('New branch must descend from the stack top');
    if (options.all || options.update) commands.push(['add', '--update', '--', '.']);
    if (options.message) commands.push(['commit', '-m', String(options.message)]);
    state.branches.push(name);
  } else if (['checkout', 'up', 'down', 'top', 'bottom', 'trunk'].includes(action)) {
    if (action === 'checkout') {
      if (args.length !== 1) usage('Select one stack, branch, PR number or URL');
      destination = select(args[0]!);
    } else if (action === 'up' || action === 'down') {
      if (args.length > 1 || args[0] !== undefined && !/^[1-9]\d*$/.test(args[0])) usage('Select a positive step count');
      const index = state.branches.indexOf(snapshot.branch);
      if (index < 0 && snapshot.branch !== state.trunk) usage('Current branch is outside the stack');
      const target = index + (action === 'up' ? 1 : -1) * Number(args[0] ?? 1);
      if (target < -1 || target >= state.branches.length) usage('Movement is outside the stack');
      destination = target === -1 ? state.trunk : state.branches[target]!;
    } else {
      if (args.length) usage('Navigation takes no positional arguments');
      destination = action === 'trunk' ? state.trunk : action === 'top' ? state.branches.at(-1) : state.branches[0];
      if (!destination) usage('The stack has no remaining branches');
    }
    commands.push(['checkout', destination!]);
  } else if (action === 'push') {
    if (args.length) usage('stack push takes no positional arguments');
    if (!state.branches.length) usage('The stack has no remaining branches to push');
    const leases = state.branches.map(name => '--force-with-lease=refs/heads/' + name + ':' +
      (remoteRefs.split('\n').find(line => line.endsWith('\trefs/heads/' + name))?.split('\t')[0] ?? ''));
    commands.push(['push', '--atomic', ...leases, '--', remote.url, ...state.branches.map(name => 'refs/heads/' + name + ':refs/heads/' + name)]);
  } else if (action === 'sync') {
    if (args.length) usage('stack sync takes no positional arguments');
    const page = await collect(client, base + '/pulls?state=all');
    if (page.truncated) throw new CliError('INCOMPLETE_READ', 'Sync requires a complete PR collection');
    apiPreconditions.push(page.items);
    for (const linked of state.pulls) {
      const pull = page.items.find(pull => pull.number === linked.number);
      if (!pull) throw new CliError('NOT_FOUND_OR_HIDDEN', 'A recorded PR is missing from the complete sync result');
      const head = object(pull.head);
      if (head.ref !== linked.branch || object(head.repo).full_name !== state.repository ||
          !/^[a-f0-9]{40}$/.test(String(head.sha)) || !['open', 'closed'].includes(String(pull.state))) {
        throw new CliError('INVALID_RESPONSE', 'A synced PR changed its recorded branch or repository identity');
      }
      linked.head = String(head.sha); linked.base = await git.branch(String(object(pull.base).ref));
      linked.state = pull.state as 'open' | 'closed'; linked.merged = pull.merged === true;
    }
    const existing = [state.trunk, ...state.branches].filter(name => remoteRefs.split('\n').some(line => line.endsWith('\trefs/heads/' + name)));
    if (existing.length) commands.push(['fetch', '--no-tags', '--', remote.url, ...existing.map(name => 'refs/heads/' + name + ':refs/remotes/' + remote.name + '/' + name)]);
    if (options.prune) {
      for (const member of [...state.branches]) {
        const linked = state.pulls.find(pull => pull.branch === member);
        const pull = page.items.find(pull => pull.number === linked?.number);
        if (!linked || !pull || pull.merged !== true || object(pull.head).sha !== await git.tip('refs/heads/' + member)) continue;
        if (member === snapshot.branch || snapshot.worktrees.split('\n').includes('branch refs/heads/' + member)) continue;
        const merge = String(pull.merge_commit_sha);
        if (!/^[a-f0-9]{40}$/.test(merge) || !await git.run(['rev-parse', '--verify', '--quiet', merge + '^{commit}'], [0, 1]) ||
            !await ancestor(git, 'refs/heads/' + member, merge)) continue;
        commands.push(['branch', '-d', member]);
      }
    }
  } else if (action === 'unstack') {
    if (args.length > 1 || args[0] !== undefined && args[0] !== state.id) usage('Select the recorded stack identity');
    if (!options.local) {
      for (const pull of state.pulls) {
        const plan = await pullPlan(client, 'pr edit', base, String(pull.number), { base: state.trunk });
        plans.push(plan); apiPreconditions.push(plan.preconditions);
      }
    }
    remove = true;
  } else if (action === 'merge') {
    if (args.length !== 1) usage('Select the stack identity or linked PR');
    const selected = args[0] === state.id ? state.branches.at(-1)! : select(args[0]!);
    const styles = ['merge', 'squash', 'rebase'].filter(key => options[key]);
    if (styles.length + Number(options['merge-method'] !== undefined) !== 1) usage('Choose exactly one merge method');
    const method = String(options['merge-method'] ?? styles[0]);
    if (!['merge', 'squash', 'rebase'].includes(method)) usage('Use merge, squash or rebase');
    for (const member of state.branches.slice(0, state.branches.indexOf(selected) + 1)) {
      const linked = state.pulls.find(pull => pull.branch === member) ?? usage('Every merged stack branch requires a linked PR');
      const pull = object(await read(client, base + '/pulls/' + linked.number));
      apiPreconditions.push(pull);
      if (pull.merged === true) {
        const head = object(pull.head);
        if (pull.state !== 'closed' || head.ref !== member || object(head.repo).full_name !== state.repository ||
            head.sha !== await git.tip('refs/heads/' + member)) throw new CliError('STALE_HEAD', 'Completed dependency differs from its owned branch');
        linked.state = 'closed'; linked.merged = true; linked.head = String(head.sha);
        continue;
      }
      if (linked.base !== state.trunk) {
        const edit = await pullPlan(client, 'pr edit', base, String(linked.number), { base: state.trunk });
        plans.push(edit); apiPreconditions.push(edit.preconditions);
      }
      const plan = await pullPlan(client, 'pr merge', base, String(linked.number), { method, 'match-head-commit': await git.tip('refs/heads/' + member) });
      plans.push(plan); apiPreconditions.push(plan.preconditions);
    }
  } else if (action === 'rebase') {
    if (recoveringRebase) {
      rebase = state.pending?.rebase ?? usage('No recorded stack rebase to recover');
    } else {
      if (args.length > 1) usage('Select at most one stack branch');
      const selected = args[0] ?? snapshot.branch;
      const index = state.branches.indexOf(selected);
      if (index < 0) usage('Select a stack branch for rebase');
      const first = options.downstack ? 0 : index;
      const last = options.upstack ? state.branches.length : index + 1;
      const branches = state.branches.slice(first, last).filter(name => !(options['no-trunk'] && state.branches.indexOf(name) === 0));
      if (!branches.length) usage('The selected rebase scope is empty');
      const originalTips = Object.create(null) as Record<string, string>, oldBases = Object.create(null) as Record<string, string>;
      for (const name of state.branches) originalTips[name] = await git.tip('refs/heads/' + name);
      for (const name of branches) {
        const parent = state.branches[state.branches.indexOf(name) - 1] ?? state.trunk;
        oldBases[name] = await git.run(['merge-base', 'refs/heads/' + parent, 'refs/heads/' + name]);
      }
      rebase = { branches, oldBases, originalTips, expectedTips: { ...originalTips }, originalBranch: snapshot.branch, cursor: 0, dispatched: false,
        authorDate: Boolean(options['committer-date-is-author-date']) };
      state.pending = { action: 'rebase', rebase, confirmations: [], originalBranch: snapshot.branch, originalTips: snapshot.refs, steps: [] };
    }
  } else usage('Unknown stack operation');

  const localAction = action === 'rebase' ? options.continue ? 'continue' : options.abort ? 'abort' : 'rebase' :
    ['up', 'down', 'top', 'bottom', 'trunk'].includes(action) ? 'checkout' : action;
  const local = 'gitea.local.stack.' + localAction;
  const begin: WriteStep = { method: 'LOCAL', path: git.cwd, local, payload: { phase: 'begin', action, args, options: { ...options, preview: undefined, confirm: undefined }, remote,
    ...(recovering ? { recoverLocal: before!.pending!.confirmations } : {}) } };
  const finish: WriteStep = { method: 'LOCAL', path: git.cwd, local, payload: { phase: 'finish', state, commands, remove, destination } };
  const steps: WriteStep[] = [begin];
  const apiResultIndices: number[] = [];
  for (const [index, plan] of plans.entries()) {
    steps.push({ method: 'LOCAL', path: git.cwd, local, payload: { phase: 'prepare', index } });
    apiResultIndices.push(steps.length);
    steps.push(...plan.steps, { method: 'LOCAL', path: git.cwd, local, payload: { phase: 'verify', index } });
  }
  steps.push(finish);
  const plan: WritePlan = { target: git.cwd, reads: [], steps, preconditions: { metadata: before ?? null, snapshot, api: apiPreconditions,
    remoteRefs: remoteRefs || null },
  ...(recovering ? { recoverLocal: before!.pending!.confirmations } : {}),
  notes: action === 'merge' ? { yes: true, order: plans.filter(plan => plan.pull?.action === 'merge').map(plan => plan.target) } : undefined };
  let unlock: (() => Promise<void>) | undefined;
  const runtimePlans = [...plans];
  try {
    return await write(client, identity, plan, options, async (step, results, confirmation) => {
      const payload = object(step.payload);
      if (payload.phase === 'begin') {
        unlock = await lock(directory);
        if (!same(before, await stackAt(path, git)) || !same(snapshot, await git.snapshot())) throw new CliError('CONFIRMATION_MISMATCH', 'Stack or workspace changed before dispatch');
        if (action !== 'rebase') state.pending = { action, confirmations: recovering ? [...before!.pending!.confirmations] : [],
          originalBranch: before?.pending?.originalBranch ?? snapshot.branch, originalTips: before?.pending?.originalTips ?? snapshot.refs,
          steps: [...plans.map(plan => ({ effect: plan.target, state: 'pending' as const })), ...commands.map(command => ({ effect: command[0]!, state: 'pending' as const }))] };
        state.pending!.confirmations.push(confirmation);
        await save(path, state);
        return { state: 'started' };
      }
      if (payload.phase === 'prepare') {
        const index = Number(payload.index), planned = plans[index]!;
        if (planned.pull?.action === 'merge') {
          const fresh = await pullPlan(client, 'pr merge', base, planned.target.split('/').at(-1), {
            method: String(object(planned.steps[0]!.payload).Do), 'match-head-commit': String(planned.pull.expected.headSHA),
          });
          if (!same(fresh.steps, planned.steps) || fresh.pull!.expected.base !== state.trunk) throw new CliError('STALE_HEAD', 'Stack merge base or checked head changed');
          runtimePlans[index] = fresh;
        }
        state.pending!.steps[index]!.state = 'dispatched'; await save(path, state);
        return { prepared: planned.target };
      }
      if (payload.phase === 'verify') {
        const index = Number(payload.index);
        await verifyPlannedPull(client, runtimePlans[index]!, results[apiResultIndices[index]!]);
        const verified = runtimePlans[index]!.pull!;
        const member = state.pulls.find(pull => pull.number === Number(runtimePlans[index]!.target.split('/').at(-1)));
        if (member) {
          member.base = String(verified.expected.base); member.head = String(verified.expected.headSHA);
          member.merged = verified.action === 'merge' || verified.expected.merged === true;
          member.state = member.merged ? 'closed' : verified.expected.state as 'open' | 'closed';
        }
        state.pending!.steps[index]!.state = 'completed'; await save(path, state);
        return { verified: plans[index]!.target };
      }
      if (rebase) {
        const nativeRebase = existsSync(await git.run(['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'])) ||
          existsSync(await git.run(['rev-parse', '--path-format=absolute', '--git-path', 'rebase-apply']));
        for (const [name, expected] of Object.entries(rebase.expectedTips)) {
          if (await git.tip('refs/heads/' + name) !== expected) throw new CliError('STACK_RECOVERY_REQUIRED', 'A branch tip changed outside the recorded checkpoint; no effect repeated');
        }
        if (options.abort) {
          if (nativeRebase) await git.run(['rebase', '--abort']);
          for (const [name, expected] of Object.entries(rebase.expectedTips)) {
            if (expected !== rebase.originalTips[name]) await git.run(['update-ref', 'refs/heads/' + name, rebase.originalTips[name]!, expected]);
          }
          await git.run(['checkout', rebase.originalBranch]);
        } else {
          if (rebase.dispatched) {
            if (!nativeRebase || !options.continue) throw new CliError('STACK_RECOVERY_REQUIRED', 'Dispatched rebase has no native conflict state; inspect it without repeating the effect');
            await git.run(['rebase', '--continue']);
            const name = rebase.branches[rebase.cursor]!;
            rebase.expectedTips[name] = await git.tip('refs/heads/' + name);
            rebase.cursor++; rebase.dispatched = false; await save(path, state);
          }
          for (; rebase.cursor < rebase.branches.length;) {
            const name = rebase.branches[rebase.cursor]!;
            const parent = state.branches[state.branches.indexOf(name) - 1] ?? state.trunk;
            rebase.dispatched = true; await save(path, state);
            await git.run(['rebase', ...(rebase.authorDate ? ['--committer-date-is-author-date'] : []), '--onto',
              'refs/heads/' + parent, rebase.oldBases[name]!, name]);
            rebase.expectedTips[name] = await git.tip('refs/heads/' + name);
            rebase.cursor++; rebase.dispatched = false; await save(path, state);
          }
          await git.run(['checkout', rebase.originalBranch]);
        }
      } else {
        for (const [index, command] of commands.entries()) {
          state.pending!.steps[plans.length + index]!.state = 'dispatched'; await save(path, state);
          await git.run(command);
          if (action === 'sync' && command[0] === 'branch') {
            state.branches = state.branches.filter(name => name !== command[2]);
            state.pulls = state.pulls.filter(pull => pull.branch !== command[2]);
          }
          state.pending!.steps[plans.length + index]!.state = 'completed'; await save(path, state);
        }
        if (action === 'push') {
          const refs = await git.run(['ls-remote', '--heads', '--', remote.url]);
          for (const name of state.branches) {
            if (!refs.split('\n').includes(await git.tip('refs/heads/' + name) + '\trefs/heads/' + name)) throw new CliError('READBACK_MISMATCH', 'Selected remote did not confirm all pushed branch tips');
          }
        }
      }
      delete state.pending;
      state.revision++;
      if (remove) await rm(path); else await save(path, state);
      return { stack: remove ? null : state, current: await git.run(['symbolic-ref', '--short', 'HEAD']) };
    });
  } finally { if (unlock) await unlock(); }
}
