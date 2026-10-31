import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { CliError } from './error.js';

export async function readPrivateFile(path: string, secret = false): Promise<string> {
  if (secret && process.platform === 'win32') throw new CliError('CONFIG_INVALID', 'File SecretRef protection cannot be verified on Windows; use env SecretRefs');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new CliError('CONFIG_INSECURE', 'Private file must be a regular owned file; use chmod 600');
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.platform !== 'win32' &&
        (stat.uid !== process.getuid!() || (stat.mode & (secret ? 0o077 : 0o022)) !== 0))) {
      throw new CliError('CONFIG_INSECURE', 'Private file must be owned and protected; use chmod 600');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
