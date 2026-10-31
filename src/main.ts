import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { encode } from '@toon-format/toon';
import { commands } from './registry.js';
import { CliError } from './error.js';
import { readRepository } from './repository.js';
import { configPath, credentials, profileList, redact } from './credentials.js';
import { Client } from './transport.js';
import { collect, object, rawPath, rawRead, read } from './api.js';
import { boundedList, issueFields, listIssues, listOptions, positive, prFields, repository, selectedFields, view, watchChecks } from './reads.js';
import type { Options } from './reads.js';

export async function main(args: string[]) {
  let operation = 'dashboard';
  try {
    if (args.some(arg => /^--(?:token|api-key|password|authorization)(?:=|$)/i.test(arg))) {
      throw new CliError('CONFIG_INVALID', 'token and other secret arguments are not accepted');
    }
    const path = args.length === 0 || args[0]?.startsWith('--') ? ['dashboard'] : args.slice(0, ['api', 'doctor', 'dashboard'].includes(args[0]!) ? 1 : 2);
    const command = commands.find(command => command.path.join(' ') === path.join(' '));
    if (!command) throw new CliError('USAGE', 'Unknown command; use gitea-axi --help', 2);
    operation = command.path.join(' ');
    const rest = args[0]?.startsWith('--') || !args.length ? args : args.slice(path.length);
    let parsed;
    try {
      parsed = parseArgs({
        args: rest, allowPositionals: true, strict: true, tokens: true,
        options: Object.fromEntries(Object.entries(command.flags).map(([name, flag]) => [name, { type: flag.type }])),
      });
    } catch {
      throw new CliError('USAGE', 'Invalid arguments; valid flags: ' + Object.keys(command.flags).map(f => '--' + f).join(', '), 2);
    }
    const { values, positionals } = parsed;
    const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) {
      throw new CliError('USAGE', 'Choose each flag only once; --repo requires exactly one selector', 2);
    }
    if (values.help) {
      console.log(encode({ bin: process.argv[1], description: command.description, command: 'gitea-axi ' + operation,
        flags: Object.entries(command.flags).map(([name, flag]) => ({ flag: '--' + name, ...flag })),
        ...(operation === 'dashboard' ? { commands: commands.map(command => command.path.join(' ')) } : {}),
        examples: operation === 'api' ? ['gitea-axi api GET repos/OWNER/NAME', 'gitea-axi api version'] :
          [`gitea-axi ${operation} --help`, `gitea-axi ${operation} --profile <name>`] }));
      return;
    }
    const options = values as Options;
    const takesNumber = ['issue view', 'pr view', 'pr checks', 'pr diff'].includes(operation);
    if (takesNumber && (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]!))) throw new CliError('USAGE', 'Select exactly one positive item number', 2);
    if (!takesNumber && operation !== 'api' && operation !== 'org view' && positionals.length) throw new CliError('USAGE', 'Unexpected positional argument', 2);
    if (operation === 'org view' && (positionals.length !== 1 || !/^[A-Za-z0-9_.-]+$/.test(positionals[0]!))) throw new CliError('USAGE', 'Select one organization name', 2);
    if (operation.endsWith('list')) listOptions(options);
    if (operation === 'issue view' || operation === 'issue list') selectedFields(options, issueFields);
    if (operation === 'pr view') selectedFields(options, prFields);
    if (operation === 'pr list') selectedFields(options, issueFields.concat(['isDraft', 'headRefName', 'baseRefName']));
    if (operation === 'pr checks') {
      if ((options.interval || options.timeout) && !options.watch) throw new CliError('USAGE', '--timeout and --interval require --watch', 2);
      if (options.watch && !options.timeout) throw new CliError('USAGE', '--watch requires --timeout seconds', 2);
      positive(options.timeout, 30, 3600); positive(options.interval, 5, 60);
    }
    let apiPath: string | undefined;
    if (operation === 'api') {
      if (positionals.length === 2 && positionals[0] !== 'GET') throw new CliError('READ_ONLY', 'Only GET metadata reads are available');
      if (positionals.length < 1 || positionals.length > 2) throw new CliError('USAGE', 'Use gitea-axi api [GET] <relative-path>', 2);
      apiPath = rawPath(positionals.at(-1)!);
    }
    if (options.config && (typeof options.config !== 'string' || !isAbsolute(options.config))) throw new CliError('USAGE', '--config must be absolute', 2);
    if (operation === 'config path') { console.log(encode({ path: configPath(options.config as string | undefined) })); return; }
    if (operation === 'profile list') { console.log(encode(await profileList(options.config as string | undefined))); return; }
    const identity = await credentials(typeof values.origin === 'string' ? values.origin : undefined, Boolean(values['allow-insecure-http']), {
      ...(typeof options.config === 'string' ? { config: options.config } : {}), ...(typeof options.profile === 'string' ? { profile: options.profile } : {}),
    });
    const client = new Client(identity.origin, identity.token, operation === 'pr checks' && options.watch ? positive(options.timeout, 30, 3600) * 1000 : 30_000);
    let output: unknown;
    if (operation === 'auth status') output = { profile: identity.profile ?? 'anonymous', origin: identity.origin, source: identity.source ?? 'anonymous', authenticated: Boolean(identity.token) };
    else if (operation === 'doctor') output = { origin: identity.origin, identity: await read(client, '/api/v1/user') };
    else if (operation === 'api') output = await rawRead(client, apiPath!);
    else if (operation === 'org view') output = { organization: await read(client, '/api/v1/orgs/' + encodeURIComponent(positionals[0]!)) };
    else if (operation === 'repo list') {
      if (options.fields) throw new CliError('USAGE', 'repo list supports its compact identity fields only', 2);
      const path = options.org ? '/api/v1/orgs/' + encodeURIComponent(String(options.org)) + '/repos' : '/api/v1/repos/search';
      output = boundedList(await collect(client, path, options.org ? undefined : 'data'), positive(options.limit, 30, 1000), ['id', 'full_name', 'default_branch']);
    } else {
      const repo = repository(values.repo, identity.origin);
      const base = '/api/v1/repos/' + repo.split('/').map(encodeURIComponent).join('/');
      if (operation === 'repo view') output = await readRepository(identity.origin, repo, identity.token);
      else if (operation === 'dashboard') {
        const sections: Record<string, unknown> = {};
        for (const [name, path, envelope] of [['repository', base], ['issues', base + '/issues?state=open&type=issues'], ['pulls', base + '/pulls?state=open'], ['labels', base + '/labels'], ['releases', base + '/releases'], ['runs', base + '/actions/tasks', 'workflow_runs']]) {
          try {
            sections[name!] = name === 'repository' ? { status: 'ok', data: await read(client, path!) } :
              { status: 'ok', ...boundedList(await collect(client, path!, envelope), 5, name === 'labels' ? ['id', 'name', 'color'] : ['id', 'number', 'title', 'state']) };
          } catch (error) {
            if (!(error instanceof CliError)) throw error;
            sections[name!] = { status: 'error', code: error.code, reason: error.message };
          }
        }
        output = { bin: process.argv[1], description: 'Gitea repository reads', repository: repo, partial: Object.values(sections).some(section => object(section).status === 'error'), sections,
          help: [`gitea-axi issue list --repo ${repo}`, `gitea-axi pr list --repo ${repo}`, 'gitea-axi --help'] };
      } else if (operation === 'issue list' || operation === 'pr list') output = await listIssues(client, base, operation === 'pr list' ? 'pr' : 'issue', options);
      else if (operation === 'issue view' || operation === 'pr view') output = await view(client, base, operation === 'pr view' ? 'pr' : 'issue', positionals[0]!, options);
      else if (['label list', 'run list', 'release list'].includes(operation)) output = boundedList(await collect(client, base + (operation === 'label list' ? '/labels' : operation === 'release list' ? '/releases' : '/actions/tasks'), operation === 'run list' ? 'workflow_runs' : undefined), positive(options.limit, 30, 1000), operation === 'label list' ? ['id', 'name', 'color'] : ['id', 'name', 'status', 'conclusion']);
      else if (operation === 'pr checks') {
        const result = await watchChecks(client, base, positionals[0]!, options);
        process.exitCode = result.exitCode;
        output = result;
      } else if (operation === 'pr diff') {
        const response = await client.request(base + '/pulls/' + positionals[0] + '.diff', true);
        const text = String(response.data);
        const ceiling = options.full ? 100_000 : 10_000;
        output = { diff: text.slice(0, ceiling), chars: text.length, truncated: text.length > ceiling, ...(text.length > ceiling ? { help: 'Use --full within the 100000 character diff ceiling' } : {}) };
      }
    }
    const rendered = encode(redact(output));
    if (rendered.length > 100_000) throw new CliError('OUTPUT_LIMIT', 'Rendered output exceeds 100000 characters; select fewer fields or a lower --limit');
    console.log(rendered);
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('INTERNAL_ERROR', 'Unable to read the repository');
    console.log(encode(redact({ error: { code: failure.code, operation, reason: failure.message }, help: 'gitea-axi ' + operation + ' --help' })));
    process.exitCode = failure.exitCode;
  }
}
