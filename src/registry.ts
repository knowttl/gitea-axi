export const command = {
  path: ['repo', 'view'],
  description: 'Read repository identity and default branch with server contract metadata.',
  commandIds: ['C075'],
  operations: ['OP-001', 'OP-002', 'OP-004'],
  outcomes: ['AC-001', 'AC-002', 'AC-004'],
  effect: 'read',
  flags: {
    repo: { type: 'string', required: true, description: 'Repository as OWNER/NAME' },
    origin: { type: 'string', required: true, description: 'Gitea origin; HTTPS by default' },
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
