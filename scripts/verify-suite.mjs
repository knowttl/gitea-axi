import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

await import('./verify-package.ts');

for (const task of ['S1.1', 'S2.1', 'S2.2', 'S2.3', 'S2.4', 'S3.1', 'S3.2', 'S3.3', 'S3.4', 'S3.5', 'S4.1', 'S4.2', 'S4.3', 'S5.1', 'S5.2', 'S6.1', 'S6.2', 'S6.3', 'S6.4']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('verify.mjs', import.meta.url)), '--task', task], {
    stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + fileURLToPath(new URL('deny-network.ts', import.meta.url))].filter(Boolean).join(' ') },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Offline verification failed: ' + task);
}
