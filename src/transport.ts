import { limits } from './registry.js';
import { CliError } from './error.js';
import { canonicalPath } from './api.js';
import { transferBytes } from './attachments.js';

function transportCause(error: unknown): string {
  if (!(error instanceof Error)) return 'connection error';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'ETIMEDOUT';
  const cause = error.cause ?? error;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  if (typeof code === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return code;
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'ETIMEDOUT';
    if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(code)) return 'TLS error';
  }
  return 'connection error';
}

export class Client {
  readonly deadline: number;
  constructor(readonly origin: string, readonly token?: string, timeoutMs: number = limits.timeoutMs) {
    this.deadline = Date.now() + timeoutMs;
  }
  async request(path: string, text = false, mutation?: { method: string; payload?: unknown; sensitive?: boolean; upload?: { name: string; type: string; base64: string } }) {
    canonicalPath(path);
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !path.startsWith('/') || path.startsWith('//')) throw new CliError('UNSAFE_PATH', 'Request must stay within the selected origin');
  try {
    const form = mutation?.upload ? new FormData() : undefined;
    if (form && mutation?.upload) form.set('attachment', new Blob([Buffer.from(mutation.upload.base64, 'base64')], { type: mutation.upload.type }), mutation.upload.name);
    const response = await fetch(url, {
      method: mutation?.method ?? 'GET',
      ...(form ? { body: form } : mutation?.payload === undefined ? {} : { body: JSON.stringify(mutation.payload) }),
      headers: { accept: text ? 'text/plain' : 'application/json', ...(mutation && !form ? { 'content-type': 'application/json' } : {}), ...(this.token ? { authorization: 'token ' + this.token } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(limits.timeoutMs, this.deadline - Date.now()))),
    });
    if (mutation?.sensitive) {
      await response.body?.cancel();
      if (!response.ok) throw new CliError('HTTP_ERROR', 'Protected secret operation returned HTTP ' + response.status);
      return { data: null, headers: response.headers };
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
    if (response.ok && response.status !== 204 && !text && !(mutation && body === '') && !response.headers.get('content-type')?.includes('application/json')) throw new CliError('INVALID_RESPONSE', 'Gitea did not return JSON');
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
    return { data: response.status === 204 || mutation && body === '' ? null : text ? body : JSON.parse(body) as unknown, headers: response.headers };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) throw new CliError('INVALID_RESPONSE', 'Gitea returned malformed JSON');
    throw new CliError('TRANSPORT_ERROR', 'Gitea request failed (' + transportCause(error) + '); check the selected origin and connection');
  }
  }
  async get(path: string): Promise<unknown> { return (await this.request(path)).data; }
  async attachment(uuid: string, expectedType?: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uuid)) throw new CliError('UNSAFE_PATH', 'Invalid attachment UUID');
    try {
      const response = await fetch(new URL('/attachments/' + uuid, this.origin), { headers: { ...(this.token ? { authorization: 'token ' + this.token } : {}) }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, this.deadline - Date.now())) });
      const type = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (!response.ok || !type || expectedType && type !== expectedType) {
        await response.body?.cancel();
        throw new CliError('INVALID_RESPONSE', 'Binary attachment returned an unexpected status or content type');
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > transferBytes) throw new CliError('TRANSFER_LIMIT', 'Binary attachment exceeds 10000000 bytes');
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), type };
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('TRANSPORT_ERROR', 'Binary attachment transfer failed; redirects are refused');
    }
  }
}

export async function get(origin: string, path: string, token?: string): Promise<unknown> {
  return new Client(origin, token).get(path);
}
