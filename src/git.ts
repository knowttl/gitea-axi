import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { CliError } from './error.js';
import { createHash } from 'node:crypto';

export class Git {
  constructor(readonly cwd: string, readonly origin: string, private readonly token?: string) {}

  async run(args: string[], allowed = [0]): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
      GIT_CONFIG_COUNT: this.token ? '1' : '0',
      ...(this.token ? { GIT_CONFIG_KEY_0: 'http.' + this.origin + '/.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: token ' + this.token } : {}),
    };
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
        '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never',
        '-c', 'protocol.http.allow=always', '-c', 'protocol.https.allow=always', ...args], {
        cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      });
      let output = '', size = 0;
      child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 2_000_000) child.kill(); else output += bytes.toString(); });
      child.stderr.on('data', () => { /* Git diagnostics can contain credential-bearing server text. */ });
      child.on('error', () => reject(new CliError('GIT_FAILED', 'Unable to start native Git')));
      child.on('close', code => allowed.includes(code ?? -1) && size <= 2_000_000 ? resolve(output.trimEnd()) :
        reject(new CliError('GIT_FAILED', 'Native Git ' + args[0] + ' stopped; inspect the workspace for conflicts before continuing')));
    });
  }

  async workspace() {
    if (!isAbsolute(this.cwd) || await realpath(this.cwd) !== this.cwd || await this.run(['rev-parse', '--show-toplevel']) !== this.cwd) {
      throw new CliError('USAGE', '--workspace must be the absolute native repository root', 2);
    }
    const config = await this.run(['config', '--local', '--name-only', '--list']) + '\n' +
      await this.run(['config', '--worktree', '--name-only', '--list']);
    if (config.split('\n').some(key => /^(?:url\.|http\.|credential\.|include\.|includeif\.|filter\.|diff\.|core\.sshcommand$|remote\..*\.(?:proxy|uploadpack|receivepack|pushurl|vcs)$)/i.test(key))) {
      throw new CliError('UNSAFE_GIT_CONFIG', 'Workspace transport overrides must be removed before using origin-bound Git');
    }
    return this;
  }

  async clean() {
    if (await this.run(['status', '--porcelain=v1', '--untracked-files=all'])) throw new CliError('DIRTY_WORKSPACE', 'Commit or stash workspace changes before this operation');
  }

  async branch(name: string) {
    if (!name || name.startsWith('-')) throw new CliError('USAGE', 'Select a branch name', 2);
    await this.run(['check-ref-format', '--branch', name]);
    return name;
  }

  async tip(branch = 'HEAD') { return this.run(['rev-parse', '--verify', branch + '^{commit}']); }

  async snapshot() {
    const status = await this.run(['status', '--porcelain=v1', '--untracked-files=all']);
    return { head: await this.tip(), branch: await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]),
      refs: await this.run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']), status,
      diff: createHash('sha256').update(await this.run(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'])).digest('hex'),
      index: createHash('sha256').update(await this.run(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--binary', 'HEAD'])).digest('hex'),
      worktrees: await this.run(['worktree', 'list', '--porcelain']) };
  }

  url(repository: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) {
      throw new CliError('USAGE', 'Select OWNER/NAME', 2);
    }
    return this.origin + '/' + repository + '.git';
  }

  async remote(name: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new CliError('USAGE', 'Select a simple remote name', 2);
    const urls = (await this.run(['remote', 'get-url', '--all', name])).split('\n');
    const url = new URL(urls[0]!);
    if (urls.length !== 1 || url.origin !== this.origin || url.username || url.password || url.search || url.hash ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)) {
      throw new CliError('ORIGIN_MISMATCH', 'Selected remote must be one credential-free OWNER/NAME.git URL on the selected origin');
    }
    return { name, url: url.href, repository: url.pathname.slice(1, -4) };
  }
}
