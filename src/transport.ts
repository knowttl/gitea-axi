import { limits } from './registry.js';
import { CliError } from './error.js';

export class Client {
  readonly deadline: number;
  constructor(readonly origin: string, readonly token?: string, timeoutMs: number = limits.timeoutMs) {
    this.deadline = Date.now() + timeoutMs;
  }
  async request(path: string, text = false) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !path.startsWith('/') || path.startsWith('//')) throw new CliError('UNSAFE_PATH', 'Request must stay within the selected origin');
  try {
    const response = await fetch(url, {
      headers: { accept: text ? 'text/plain' : 'application/json', ...(this.token ? { authorization: 'token ' + this.token } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, this.deadline - Date.now())),
    });
    if (response.ok && !text && !response.headers.get('content-type')?.includes('application/json')) {
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
    const body = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      let reason = '';
      if (response.headers.get('content-type')?.includes('application/json')) {
        try {
          const error: unknown = JSON.parse(body);
          if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') reason = ': ' + error.message.slice(0, 1000);
        } catch { /* HTTP status remains authoritative for malformed errors. */ }
      }
      const retry = response.headers.get('retry-after');
      const code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'PERMISSION_DENIED' :
        response.status === 404 ? 'NOT_FOUND_OR_HIDDEN' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
      throw new CliError(code, `${path.split('?')[0]} returned HTTP ${response.status}${reason}${retry ? '; retry-after ' + retry : ''}`);
    }
    return { data: text ? body : JSON.parse(body) as unknown, headers: response.headers };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) throw new CliError('INVALID_RESPONSE', 'Gitea returned malformed JSON');
    throw new CliError('TRANSPORT_ERROR', 'Gitea request failed; check the selected origin and connection');
  }
  }
  async get(path: string): Promise<unknown> { return (await this.request(path)).data; }
}

export async function get(origin: string, path: string, token?: string): Promise<unknown> {
  return new Client(origin, token).get(path);
}
