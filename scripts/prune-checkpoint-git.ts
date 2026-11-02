#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./prune-checkpoint.json', import.meta.url), 'utf8')) as { git: string; workspace: string; branch: string };
const args = process.argv.slice(2);
const result = spawnSync(config.git, args, { stdio: 'inherit' });
// Lose completion after native deletion, before the CLI can save its ownership checkpoint.
if (result.status === 0 && process.cwd() === config.workspace &&
    JSON.stringify(args.slice(-3)) === JSON.stringify(['branch', '-d', config.branch])) process.exit(1);
process.exit(result.status ?? 1);
