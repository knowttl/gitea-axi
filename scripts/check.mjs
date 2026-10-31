import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--offline'], 'Select --offline');
for (const task of ['S1.1', 'S1.2']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('verify.mjs', import.meta.url)), '--task', task], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Offline verification failed: ' + task);
}
