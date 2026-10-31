import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--offline'], 'Select --offline');
const result = spawnSync(process.execPath, [fileURLToPath(new URL('verify.mjs', import.meta.url)), '--task', 'S1.1'], { stdio: 'inherit' });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Offline verification failed: S1.1');
