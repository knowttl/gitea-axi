import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const task of ['S1.1', 'S2.1', 'S2.2', 'S2.3', 'S2.4']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('verify.mjs', import.meta.url)), '--task', task], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Offline verification failed: ' + task);
}
