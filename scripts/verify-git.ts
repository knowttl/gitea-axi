import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../dist/git.js';

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'gitea-git-')));
const source = join(scratch, 'source');
const linked = join(scratch, 'linked');
function git(args: string[], cwd = source) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

try {
  git(['init', '--initial-branch=main', source], scratch);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Initial']);
  git(['worktree', 'add', '-b', 'topic', linked]);
  const workspaces = [source, linked].map(directory => new Git(directory, 'https://example.invalid', 'synthetic-token'));
  for (const workspace of workspaces) await workspace.workspace();
  console.log('Default linked-worktree configuration accepted');

  git(['config', 'extensions.worktreeConfig', 'true']);
  for (const workspace of workspaces) await workspace.workspace();
  console.log('Missing optional worktree configuration accepted');

  git(['config', '--local', 'url.https://other.invalid/.insteadOf', 'https://example.invalid/']);
  for (const workspace of workspaces) await assert.rejects(workspace.workspace(), { code: 'UNSAFE_GIT_CONFIG' });
  git(['config', '--local', '--unset', 'url.https://other.invalid/.insteadOf']);
  console.log('Shared transport overrides refused in both worktrees');

  git(['config', '--worktree', 'http.proxy', 'https://other.invalid/'], linked);
  await workspaces[0]!.workspace();
  await assert.rejects(workspaces[1]!.workspace(), { code: 'UNSAFE_GIT_CONFIG' });
  console.log('Worktree transport override refused in its own workspace');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
