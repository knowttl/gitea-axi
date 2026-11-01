export const command = {
  path: ['repo', 'view'],
  description: 'Read repository identity and default branch with server contract metadata.',
  commandIds: ['C075'],
  operations: ['OP-001', 'OP-002', 'OP-004'],
  outcomes: ['AC-001', 'AC-002', 'AC-004'],
  effect: 'read',
  flags: {
    repo: { type: 'string', default: 'matching local origin remote', description: 'Repository as OWNER/NAME' },
    origin: { type: 'string', default: 'selected profile', description: 'Gitea origin; HTTPS by default' },
    'allow-insecure-http': {
      type: 'boolean', default: false,
      description: 'Allow HTTP only for the explicitly selected origin',
    },
    help: { type: 'boolean', default: false, description: 'Show command help' },
  },
  examples: [
    'gitea-axi repo view --repo sample-owner/sample-repo --origin https://gitea.example.test',
    'gitea-axi repo view --help',
  ],
} as const;

export const limits = { timeoutMs: 30_000, responseBytes: 2_000_000 } as const;

const globalFlags = {
  origin: command.flags.origin, 'allow-insecure-http': command.flags['allow-insecure-http'], help: command.flags.help,
  config: { type: 'string', description: 'Absolute configuration path' },
  profile: { type: 'string', description: 'Select one file profile' },
} as const;
const repo = { repo: { type: 'string', description: 'OWNER/NAME; otherwise a matching local origin remote' } } as const;
const list = {
  limit: { type: 'string', description: 'Maximum returned records, default 30, maximum 1000' },
  state: { type: 'string', description: 'open, closed or all; default open' },
  sort: { type: 'string', description: 'created, updated or number; default created' },
  order: { type: 'string', description: 'asc or desc; default desc' },
  fields: { type: 'string', description: 'Comma-separated selected fields' },
} as const;
const detail = {
  fields: list.fields, full: { type: 'boolean', description: 'Full body within response ceiling' },
  comments: { type: 'boolean', description: 'Include comments' },
} as const;
const writeFlags = {
  'allow-write': { type: 'string', description: 'Comma-separated exact vendor operation IDs authorized for this workflow' },
  preview: { type: 'boolean', description: 'Preview and bind this exact write without dispatch' },
  confirm: { type: 'string', description: 'Execute the unchanged preview confirmation ID once' },
} as const;
const text = { type: 'string' } as const;
const repeated = { type: 'string', multiple: true } as const;
const issueBody = { body: text, 'body-file': { type: 'string', description: 'Body from an owned file or - for bounded stdin' } } as const;
const issueEdit = { title: text, ...issueBody, milestone: text };
const mutationDefinitions = [
  ['pr create', { ...issueEdit, base: text, head: text, assignee: repeated, label: repeated, reviewer: repeated, 'team-reviewer': repeated }],
  ['pr edit', { ...issueEdit, base: text, 'add-label': repeated, 'remove-label': repeated, 'add-assignee': repeated, 'remove-assignee': repeated, 'add-reviewer': repeated, 'remove-reviewer': repeated, 'add-team-reviewer': repeated, 'remove-team-reviewer': repeated }],
  ['pr close', { comment: text }], ['pr reopen', {}], ['pr comment', issueBody],
  ['pr update-branch', {}],
  ['pr merge', { method: text, merge: { type: 'boolean' }, squash: { type: 'boolean' }, rebase: { type: 'boolean' }, 'match-head-commit': text,
    auto: { type: 'boolean' }, admin: { type: 'boolean' }, 'delete-branch': { type: 'boolean' }, subject: text, ...issueBody }],
  ['pr review', { approve: { type: 'boolean' }, 'request-changes': { type: 'boolean' }, comment: { type: 'boolean' }, 'match-head-commit': text, ...issueBody }],
  ['issue create', { ...issueEdit, assignee: repeated, label: repeated }],
  ['issue edit', { ...issueEdit, 'add-label': repeated, 'remove-label': repeated, 'add-assignee': repeated, 'remove-assignee': repeated }],
  ['issue close', { comment: text }], ['issue reopen', {}], ['issue comment', issueBody],
  ['issue delete', {}], ['issue pin', {}], ['issue unpin', {}],
  ['label create', { name: text, color: text, description: text }],
  ['label edit', { name: text, color: text, description: text }], ['label delete', {}],
] as const;
const definitions = [
  ['dashboard', repo], ['auth status', {}], ['profile list', {}], ['config path', {}], ['doctor', {}],
  ['repo list', { limit: list.limit, org: { type: 'string', description: 'List repositories belonging to this organization' } }],
  ['org view', {}], ['issue list', { ...repo, ...list, assignee: { type: 'string' }, author: { type: 'string' }, label: { type: 'string' }, milestone: { type: 'string' } }],
  ['issue view', { ...repo, ...detail }], ['label list', { ...repo, limit: list.limit }],
  ['pr list', { ...repo, ...list, assignee: { type: 'string' }, author: { type: 'string' }, label: { type: 'string' }, milestone: { type: 'string' } }],
  ['pr view', { ...repo, ...detail, reviews: { type: 'boolean' }, checks: { type: 'boolean' } }],
  ['pr checks', { ...repo, watch: { type: 'boolean' }, timeout: { type: 'string', description: 'Watch deadline seconds, required with --watch' }, interval: { type: 'string', description: 'Watch interval seconds, default 5' } }],
  ['pr diff', { ...repo, full: detail.full }],
  ['release list', { ...repo, limit: list.limit }], ['api', { ...writeFlags,
    method: { type: 'string', short: 'X', description: 'HTTP method; cannot combine with a positional method' },
    field: { type: 'string', multiple: true, description: 'Repeatable key=value; numbers, booleans and null become JSON values' },
    'raw-field': { type: 'string', multiple: true, description: 'Repeatable key=value string' },
    input: { type: 'string', description: 'Protected JSON request file; use - for stdin' } }],
  ['write reconcile', {}],
] as const;
export interface Command {
  path: readonly string[];
  description: string;
  flags: Record<string, { type: 'string' | 'boolean'; description?: string; multiple?: boolean; short?: string }>;
  effect: string;
}
export const commands: Command[] = [
  { ...command, flags: { ...command.flags, ...globalFlags } },
  ...definitions.map(([name, flags]) => ({ path: name.split(' '), description: name === 'dashboard' ? 'Bounded repository dashboard with explicit partial results' : name,
    flags: { ...globalFlags, ...flags }, effect: 'read' })),
  ...mutationDefinitions.map(([name, flags]) => ({ path: name.split(' '), description: name === 'pr review' ? 'pr review (unresolved vendor events and atomic stale-head refusal; no posting)' : name,
    flags: { ...globalFlags, ...repo, ...writeFlags, ...flags }, effect: 'write' })),
];

const strings = (...names: string[]) => Object.fromEntries(names.map(name => [name, { type: 'string' as const }]));
const booleans = (...names: string[]) => Object.fromEntries(names.map(name => [name, { type: 'boolean' as const }]));
const stageFive: [string, Command['flags'], string][] = [
  ['run list', strings('workflow', 'branch', 'status', 'event', 'user', 'commit', 'limit', 'fields'), 'read'],
  ['run view', { ...strings('job', 'conclusion'), ...booleans('log', 'verbose', 'log-failed') }, 'read'],
  ['run watch', strings('timeout', 'interval'), 'read'],
  ['run rerun', { ...strings('job'), ...booleans('failed', 'debug') }, 'pending-write'],
  ['run cancel', {}, 'pending-write'], ['run delete', {}, 'pending-write'],
  ['run download', strings('name', 'dir'), 'download'],
  ['workflow list', { ...strings('limit'), ...booleans('all') }, 'read'],
  ['workflow view', booleans('yaml'), 'read'],
  ['workflow run', strings('ref', 'field'), 'pending-write'],
  ['workflow enable', {}, 'pending-write'], ['workflow disable', {}, 'pending-write'],
  ...['issues', 'prs', 'repos', 'commits', 'code'].map((kind): [string, Command['flags'], string] => [
    'search ' + kind,
    { ...strings('owner', 'state', 'label', 'assignee', 'author', 'sort', 'order', 'limit', 'fields', 'review', 'language', 'stars', 'revision'), ...booleans('draft') },
    'read',
  ]),
];
commands.push(...stageFive.map(([name, flags, effect]) => ({ path: name.split(' '), description: name + (effect === 'pending-write' ? ' (pending shared write gate)' : ''), flags: { ...globalFlags, ...repo, ...flags }, effect })));
