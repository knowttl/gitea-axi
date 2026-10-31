import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const task of ['S1.1', 'S2.1', 'S2.2', 'S2.3', 'S2.4', 'S5.1', 'S5.2']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('verify.mjs', import.meta.url)), '--task', task], {
    stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url))].filter(Boolean).join(' ') },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Offline verification failed: ' + task);
}
