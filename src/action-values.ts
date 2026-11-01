import { collect, object, read } from './api.js';
import type { Row } from './api.js';
import { CliError } from './error.js';
import type { Client } from './transport.js';
import type { WritePlan } from './writes.js';

export async function actionValues(client: Client, path: string) {
  const page = await collect(client, path);
  if (page.truncated) throw new CliError('INCOMPLETE_READ', 'A complete collection is required for exact value identity');
  if (path.startsWith('/api/v1/repos/') && path.endsWith('/variables')) {
    for (const row of page.items) {
      const detail = object(await read(client, path + '/' + encodeURIComponent(String(row.name))));
      row.data = detail.data;
    }
  }
  return page.items.map(row => path.endsWith('/secrets') ? { name: row.name, ...(row.created_at ? { created_at: row.created_at } : {}) } : { name: row.name, data: row.data });
}

export async function valuePlan(client: Client, path: string, name: string, action: string, value?: string): Promise<WritePlan> {
  name = name.toUpperCase();
  const before = await actionValues(client, path);
  const current = before.find(row => row.name === name);
  const secret = path.endsWith('/secrets');
  if (action === 'delete' && !current) throw new CliError('NOT_FOUND_OR_HIDDEN', 'The selected name is missing or hidden');
  const method = action === 'delete' ? 'DELETE' : secret || current ? 'PUT' : 'POST';
  const payload = action === 'delete' ? undefined : secret ? { data: value } : { value };
  return { target: path + '/' + encodeURIComponent(name), steps: [{ method, path: path + '/' + encodeURIComponent(name), ...(payload ? { payload } : {}) }],
    reads: [path], preconditions: before, sensitive: secret, value: { path, name, action, ...(secret || value === undefined ? {} : { expected: value }) } };
}

export function verifyValue(plan: WritePlan, observations: { path: string; data: unknown }[]) {
  const value = plan.value!;
  const after = (observations.find(row => row.path === value.path)!.data as unknown[]).map(object);
  const before = plan.preconditions as Row[];
  const selected = after.find(row => row.name === value.name);
  const controls = (rows: Row[]) => rows.filter(row => row.name !== value.name).map(row => ({ name: row.name, ...(value.path.endsWith('/variables') ? { data: row.data } : {}) })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (JSON.stringify(controls(before)) !== JSON.stringify(controls(after)) ||
      (value.action === 'delete' ? selected !== undefined : !selected || value.expected !== undefined && selected.data !== value.expected)) {
    throw new CliError('READBACK_MISMATCH', 'Name identity or variable readback differs from the requested change');
  }
}
