import { encode } from '@toon-format/toon';
import { redact } from './credentials.js';
import type { Row } from './api.js';

export const maxOutputChars = 100_000;
// Reserve the newline added by console.log.
const fits = (value: unknown) => encode(redact(value)).length < maxOutputChars;

function summary(value: unknown): unknown {
  if (Array.isArray(value)) return { summary: true, total_items: value.length };
  if (value && typeof value === 'object') {
    const row = value as Row;
    return { summary: true, total_fields: Object.keys(row).length,
      ...(typeof row.id === 'number' ? { id: row.id } : {}), ...(typeof row.number === 'number' ? { number: row.number } : {}) };
  }
  return typeof value === 'string' ? { summary: true, total_chars: value.length } : value;
}

export function writeOutput(value: Row): Row {
  const displayed = { ...value };
  const truncated: string[] = [];
  // Keep requested effects complete; project only their verification context.
  for (const field of ['preconditions', 'observations', 'results']) {
    if (fits(displayed)) return displayed;
    if (!(field in value)) continue;
    const context = value[field];
    if (field === 'observations' && Array.isArray(context)) {
      displayed[field] = (context as { path: string; data: unknown }[]).slice(0, 10).map(row => ({ path: row.path, data: summary(row.data) }));
      displayed.observations_total = context.length;
    } else if (field === 'results' && Array.isArray(context)) {
      displayed[field] = context.slice(0, 10).map(summary);
      displayed.results_total = context.length;
    } else displayed[field] = summary(context);
    truncated.push(field);
    displayed.truncated = true;
    displayed.truncated_fields = [...truncated];
  }
  return displayed;
}

export function diffOutput(text: string, full: boolean) {
  const candidate = (length: number) => ({ diff: text.slice(0, length), chars: text.length, truncated: text.length > length,
    ...(text.length > length ? { help: full ? 'Diff is bounded to the rendered output ceiling' : 'Use --full for a larger bounded diff' } : {}) });
  let low = 0, high = Math.min(text.length, full ? maxOutputChars : 10_000);
  if (fits(candidate(high))) return candidate(high);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  return candidate(low);
}
