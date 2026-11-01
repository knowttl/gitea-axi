import { collect } from './api.js';
import type { Client } from './transport.js';
import { positive, selectedFields } from './reads.js';
import type { Options } from './reads.js';

export const taskFields = ['id', 'name', 'display_title', 'workflow_id', 'head_branch', 'head_sha', 'event', 'status', 'run_number', 'url', 'created_at', 'updated_at', 'run_started_at'];
export function validateTasks(options: Options) {
  positive(options.limit, 10, 1000);
  selectedFields(options, taskFields, []);
}
export async function tasks(client: Client, base: string, options: Options) {
  const page = await collect(client, base + '/actions/tasks', 'workflow_runs');
  const mapping = { workflow: 'workflow_id', branch: 'head_branch', status: 'status', event: 'event', commit: 'head_sha' };
  const rows = page.items.filter(row => Object.entries(mapping).every(([flag, field]) => options[flag] === undefined || row[field] === options[flag]));
  const limit = positive(options.limit, 10, 1000);
  const fields = selectedFields(options, taskFields, []) ?? ['id', 'name', 'status'];
  return { items: rows.slice(0, limit).map(row => Object.fromEntries(fields.map(field => [field, row[field] ?? null]))), count: Math.min(rows.length, limit),
    total: page.truncated ? null : rows.length, vendor_total: page.total, next: page.next, truncated: page.truncated || rows.length > limit, continuation: page.truncated || rows.length > limit,
    scope: 'Gitea 1.23.4 ActionTask summaries; task/run identity pending commissioning. Status does not establish job conclusions or terminal run results.',
    pending: ['run details, watch, logs, artifacts and controls', '1.24.0 workflow routes require representative commissioning', 'mutations require the shared write gate'] };
}
