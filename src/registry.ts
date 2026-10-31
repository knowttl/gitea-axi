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
const definitions = [
  ['dashboard', repo], ['auth status', {}], ['profile list', {}], ['config path', {}], ['doctor', {}],
  ['repo list', { limit: list.limit, org: { type: 'string', description: 'List repositories belonging to this organization' } }],
  ['org view', {}], ['issue list', { ...repo, ...list, assignee: { type: 'string' }, author: { type: 'string' }, label: { type: 'string' }, milestone: { type: 'string' } }],
  ['issue view', { ...repo, ...detail }], ['label list', { ...repo, limit: list.limit }],
  ['pr list', { ...repo, ...list, assignee: { type: 'string' }, author: { type: 'string' }, label: { type: 'string' }, milestone: { type: 'string' } }],
  ['pr view', { ...repo, ...detail, reviews: { type: 'boolean' }, checks: { type: 'boolean' } }],
  ['pr checks', { ...repo, watch: { type: 'boolean' }, timeout: { type: 'string', description: 'Watch deadline seconds, required with --watch' }, interval: { type: 'string', description: 'Watch interval seconds, default 5' } }],
  ['pr diff', { ...repo, full: detail.full }], ['run list', { ...repo, limit: list.limit }],
  ['release list', { ...repo, limit: list.limit }], ['api', {}],
] as const;
export interface Command {
  path: readonly string[];
  description: string;
  flags: Record<string, { type: 'string' | 'boolean'; description?: string }>;
  effect: string;
}
export const commands: Command[] = [
  { ...command, flags: { ...command.flags, ...globalFlags } },
  ...definitions.map(([name, flags]) => ({ path: name.split(' '), description: name === 'dashboard' ? 'Bounded repository dashboard with explicit partial results' : name,
    flags: { ...globalFlags, ...flags }, effect: 'read' })),
];
