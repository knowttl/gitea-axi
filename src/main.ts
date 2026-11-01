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
import { tasks, validateTasks } from './ci.js';
import { search, validateSearch } from './search.js';
import { issueLabelPlan, rawWritePlan, reconcile, write } from './writes.js';
import { readPrivateFile } from './private-file.js';

async function input(path: string) {
  if (path !== '-') return readPrivateFile(path, true, 1_000_000);
  let body = '';
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 1_000_000) throw new CliError('USAGE', 'Input exceeds 1000000 bytes', 2);
  }
  return body;
}

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
        options: Object.fromEntries(Object.entries(command.flags).map(([name, flag]) => [name, { type: flag.type,
          ...(flag.multiple ? { multiple: true } : {}), ...(flag.short ? { short: flag.short } : {}) }])),
      });
    } catch {
      throw new CliError('USAGE', 'Invalid arguments; valid flags: ' + Object.keys(command.flags).map(f => '--' + f).join(', '), 2);
    }
    const { values, positionals } = parsed;
    const names = parsed.tokens.flatMap(token => token.kind === 'option' && !command.flags[token.name]?.multiple ? [token.name] : []);
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
    if (operation.startsWith('workflow ') || operation.startsWith('run ') && operation !== 'run list') {
      throw new CliError('CAPABILITY_GAP', operation + ' is pending: the 1.23.4 contract has task summaries only; 1.24.0 candidates require commissioning. Mutating controls also await the shared write gate');
    }
    const searching = operation.startsWith('search ');
    if (searching) {
      if (positionals.length !== 1) throw new CliError('USAGE', 'Select exactly one quoted search query', 2);
      validateSearch(path[1]!, positionals[0]!, options);
    }
    if (options['body-file'] !== undefined) {
      if (options.body !== undefined) throw new CliError('USAGE', 'Choose --body or --body-file', 2);
      options.body = await input(String(options['body-file']));
    }
    const takesNumber = ['issue view', 'pr view', 'pr checks', 'pr diff'].includes(operation) ||
      (command.effect === 'write' && operation.startsWith('issue ') && operation !== 'issue create');
    if (takesNumber && (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]!))) throw new CliError('USAGE', 'Select exactly one positive item number', 2);
    const takesLabel = operation === 'label edit' || operation === 'label delete';
    if (takesLabel && positionals.length !== 1) throw new CliError('USAGE', 'Select one exact label name or ID', 2);
    if (!takesNumber && !takesLabel && !searching && operation !== 'write reconcile' && operation !== 'api' && operation !== 'org view' && positionals.length) throw new CliError('USAGE', 'Unexpected positional argument', 2);
    if (operation === 'write reconcile' && positionals.length !== 1) throw new CliError('USAGE', 'Select one confirmation ID', 2);
    if (operation === 'org view' && (positionals.length !== 1 || !/^[A-Za-z0-9_.-]+$/.test(positionals[0]!))) throw new CliError('USAGE', 'Select one organization name', 2);
    if (operation.endsWith('list')) listOptions(options);
    if (operation === 'run list') validateTasks(options);
    if (operation === 'issue view' || operation === 'issue list') selectedFields(options, issueFields);
    if (operation === 'pr view') selectedFields(options, prFields);
    if (operation === 'pr list') selectedFields(options, issueFields.concat(['isDraft', 'headRefName', 'baseRefName']));
    if (operation === 'pr checks') {
      if ((options.interval || options.timeout) && !options.watch) throw new CliError('USAGE', '--timeout and --interval require --watch', 2);
      if (options.watch && !options.timeout) throw new CliError('USAGE', '--watch requires --timeout seconds', 2);
      positive(options.timeout, 30, 3600); positive(options.interval, 5, 60);
    }
    let apiPath: string | undefined;
    let method = 'GET';
    let payload: unknown;
    if (operation === 'api') {
      if (options.method && positionals.length === 2) throw new CliError('USAGE', 'Choose -X or a positional method once', 2);
      method = positionals.length === 2 ? positionals[0]! : String(options.method ?? 'GET');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CliError('USAGE', 'Use GET, POST, PUT, PATCH or DELETE', 2);
      if (positionals.length < 1 || positionals.length > 2) throw new CliError('USAGE', 'Use gitea-axi api [GET] <relative-path>', 2);
      apiPath = rawPath(positionals.at(-1)!, method);
      const fields = parsed.tokens.filter(token => token.kind === 'option' && ['field', 'raw-field'].includes(token.name));
      if (fields.length) {
        if (options.input || method === 'GET') throw new CliError('USAGE', 'Request fields require a write method and cannot combine with --input', 2);
        const body: Record<string, unknown> = {};
        for (const token of fields) {
          if (token.kind !== 'option') continue;
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(token.value ?? '');
          if (!match || ['__proto__', 'prototype', 'constructor'].includes(match[1]!) || Object.hasOwn(body, match[1]!)) throw new CliError('USAGE', 'Choose unique key=value request fields', 2);
          if (/secret|token|password|authorization|api.?key/i.test(match[1]!) || /\/secrets\//.test(apiPath)) throw new CliError('CONFIG_INVALID', 'Secret fields require protected --input');
          const value = match[2]!;
          body[match[1]!] = token.name === 'field' && /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value) ? JSON.parse(value) as unknown : value;
        }
        if (Buffer.byteLength(JSON.stringify(body)) > 1_000_000) throw new CliError('USAGE', 'Request exceeds 1000000 bytes', 2);
        payload = body;
      }
      if (method !== 'GET' && (!options['allow-write'] || process.env.GITEA_AXI_READ_ONLY && process.env.GITEA_AXI_READ_ONLY !== 'false')) throw new CliError('READ_ONLY', 'Writes require an exact operation grant and a writable policy');
      if (options.input) {
        if (method === 'GET') throw new CliError('USAGE', '--input requires a write method', 2);
        const body = await input(String(options.input));
        if (Buffer.byteLength(body) > 1_000_000) throw new CliError('USAGE', 'Request exceeds 1000000 bytes', 2);
        try { payload = JSON.parse(body); } catch { throw new CliError('USAGE', 'Request must be valid JSON', 2); }
      }
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
    else if (searching) output = await search(client, path[1]!, positionals[0]!, options);
    else if (operation === 'write reconcile') output = await reconcile(client, positionals[0]!);
    else if (operation === 'api') output = method === 'GET' ? await rawRead(client, apiPath!) :
      await write(client, identity, await rawWritePlan(client, method, apiPath!, payload), options);
    else if (operation === 'org view') output = { organization: await read(client, '/api/v1/orgs/' + encodeURIComponent(positionals[0]!)) };
    else if (operation === 'repo list') {
      if (options.fields) throw new CliError('USAGE', 'repo list supports its compact identity fields only', 2);
      const path = options.org ? '/api/v1/orgs/' + encodeURIComponent(String(options.org)) + '/repos' : '/api/v1/repos/search';
      output = boundedList(await collect(client, path, options.org ? undefined : 'data'), positive(options.limit, 30, 1000), ['id', 'full_name', 'default_branch']);
    } else {
      if (command.effect === 'write' && (!options['allow-write'] || process.env.GITEA_AXI_READ_ONLY && process.env.GITEA_AXI_READ_ONLY !== 'false')) throw new CliError('READ_ONLY', 'Writes require an exact operation grant and a writable policy');
      const repo = repository(typeof values.repo === 'string' ? values.repo : undefined, identity.origin);
      const base = '/api/v1/repos/' + repo.split('/').map(encodeURIComponent).join('/');
      if (command.effect === 'write') output = await write(client, identity, await issueLabelPlan(client, operation, base, positionals[0], options), options);
      else if (operation === 'repo view') output = await readRepository(identity.origin, repo, identity.token);
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
      else if (operation === 'run list') output = await tasks(client, base, options);
      else if (['label list', 'release list'].includes(operation)) output = boundedList(await collect(client, base + (operation === 'label list' ? '/labels' : '/releases')), positive(options.limit, 30, 1000), operation === 'label list' ? ['id', 'name', 'color'] : ['id', 'name', 'status', 'conclusion']);
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
