import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { encode } from '@toon-format/toon';
import { command } from './registry.js';
import { CliError } from './error.js';
import { readRepository } from './repository.js';

const help = readFileSync(new URL('../generated/help.txt', import.meta.url), 'utf8');

export async function main(args: string[]) {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args, allowPositionals: true, strict: true, tokens: true,
        options: Object.fromEntries(Object.entries(command.flags).map(([name, flag]) => [name, { type: flag.type }])),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid arguments';
      throw new CliError('USAGE', reason + '; valid flags: ' + Object.keys(command.flags).map(f => '--' + f).join(', '), 2);
    }
    const { values, positionals } = parsed;
    const options = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(options).size !== options.length) {
      throw new CliError('USAGE', 'Choose each flag only once; --repo requires exactly one selector', 2);
    }
    const matches = positionals.length === command.path.length && positionals.every((part, index) => part === command.path[index]);
    if ((values.help || args.length === 0) && (matches || positionals.length === 0)) {
      console.log(encode({ bin: process.argv[1] }));
      process.stdout.write(help);
      return;
    }
    if (!matches) throw new CliError('USAGE', 'Unknown command; use gitea-axi repo view --help', 2);
    const repo = values.repo;
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo)) {
      throw new CliError('USAGE', '--repo must be OWNER/NAME', 2);
    }
    let origin: URL;
    try {
      if (typeof values.origin !== 'string') throw new Error();
      origin = new URL(values.origin);
    } catch {
      throw new CliError('USAGE', '--origin must be an explicit Gitea origin', 2);
    }
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        !['https:', 'http:'].includes(origin.protocol)) {
      throw new CliError('USAGE', '--origin must contain only scheme, hostname and optional port', 2);
    }
    if (origin.protocol === 'http:' && !values['allow-insecure-http']) {
      throw new CliError('USAGE', 'HTTP requires --allow-insecure-http for the explicit --origin', 2);
    }
    console.log(encode(await readRepository(origin.origin, repo)));
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('INTERNAL_ERROR', 'Unable to read the repository');
    console.log(encode({ error: { code: failure.code, operation: 'repo view', reason: failure.message }, help: 'gitea-axi repo view --help' }));
    process.exitCode = failure.exitCode;
  }
}
