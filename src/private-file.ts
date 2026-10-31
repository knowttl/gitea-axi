import { open, mkdir, chmod, rename, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './error.js';

export async function readPrivateFile(path: string, secret = false, maxBytes?: number): Promise<string> {
  if (secret && process.platform === 'win32') throw new CliError('CONFIG_INVALID', 'File SecretRef protection cannot be verified on Windows; use env SecretRefs');
  const info = await lstat(path).catch(() => { throw new CliError('CONFIG_INSECURE', 'Private file is unavailable'); });
  if (!info.isFile() || info.isSymbolicLink()) throw new CliError('CONFIG_INSECURE', 'Private file must be a regular owned file; use chmod 600');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new CliError('CONFIG_INSECURE', 'Private file must be a regular owned file; use chmod 600');
  });
  try {
    const stat = await file.stat();
    if (maxBytes !== undefined && stat.size > maxBytes) throw new CliError('USAGE', 'Input exceeds ' + maxBytes + ' bytes', 2);
    if (!stat.isFile() || (process.platform !== 'win32' &&
        (stat.uid !== process.getuid!() || (stat.mode & (secret ? 0o077 : 0o022)) !== 0))) {
      throw new CliError('CONFIG_INSECURE', 'Private file must be owned and protected; use chmod 600');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  if (process.platform === 'win32') throw new CliError('CONFIG_INSECURE', 'Native Windows ACL writes are unavailable');
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!()) {
    throw new CliError('CONFIG_INSECURE', 'Private directory must be owned and cannot be a symlink');
  }
  await chmod(directory, 0o700);
  const temporary = join(directory, '.' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}
