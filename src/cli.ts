#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const versionArgs = args.filter(arg => !['--json', '--json=true', '--json=false'].includes(arg));
if (args.length <= 2 && versionArgs.length === 1 && ['--version', '-v', '-V'].includes(versionArgs[0] ?? '')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  const { main } = await import('./main.js');
  await main(args);
}
