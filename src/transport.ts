import { limits } from './registry.js';
import { CliError } from './error.js';

export async function get(origin: string, path: string, token?: string): Promise<unknown> {
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { accept: 'application/json', ...(token ? { authorization: 'token ' + token } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CliError('HTTP_ERROR', `Gitea returned HTTP ${response.status}`);
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw new CliError('INVALID_RESPONSE', 'Gitea did not return JSON');
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > limits.responseBytes) {
        throw new CliError('RESPONSE_LIMIT', 'Gitea response exceeded the byte limit');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) throw new CliError('INVALID_RESPONSE', 'Gitea returned malformed JSON');
    throw new CliError('TRANSPORT_ERROR', 'Gitea request failed; check the selected origin and connection');
  }
}
