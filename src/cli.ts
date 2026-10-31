#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0] ?? '')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  const { main } = await import('./main.js');
  await main(args);
}
