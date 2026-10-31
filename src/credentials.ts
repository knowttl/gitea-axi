import { readFileSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Ajv } from 'ajv';
import { CliError } from './error.js';
import { readPrivateFile } from './private-file.js';

interface Profile {
  origin: string;
  tokenOrigin: string;
  token: { env: string } | { file: string };
  allowInsecureHttp?: boolean;
  writes?: { allowWrites: boolean; operations: string[] };
}
const schema = JSON.parse(readFileSync(new URL('../axi-credential.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: false }).compile<Profile>(schema);
const secrets: string[] = [];

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:token|access_token|refresh_token|password|secret|authorization|private_key)$/i.test(key) ? '[REDACTED]' : redact(item)]));
  if (typeof value !== 'string') return value;
  let output = value;
  for (const secret of secrets) {
    for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      output = output.replaceAll(form, '[REDACTED]');
    }
  }
  return output.replace(/([?&](?:token|access_token|api_key|sig)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/(AccountKey=)[^;\s]+/gi, '$1[REDACTED]');
}

export function configPath(explicit?: string): string {
  const base = process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME;
  return explicit ?? process.env.GITEA_AXI_CONFIG ?? join(base && isAbsolute(base) ? base : join(homedir(), '.config'), 'gitea-axi', 'config.json');
}

export async function profileList(explicit?: string) {
  const path = configPath(explicit);
  if (!existsSync(path)) return { path, profiles: [] };
  const config = await readConfig(path);
  return { path, profiles: Object.keys(config.profiles).map(name => ({ name, default: name === config.defaultProfile })) };
}

async function readConfig(path: string) {
  let config: { version?: unknown; defaultProfile?: string; profiles: Record<string, unknown> };
  try { config = JSON.parse(await readPrivateFile(path)); }
  catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('CONFIG_INVALID', 'Invalid profile configuration');
  }
  if (!config || config.version !== 1 || !config.profiles || Array.isArray(config.profiles) || typeof config.profiles !== 'object' ||
      Object.keys(config).some(key => !['version', 'profiles', 'defaultProfile'].includes(key)) ||
      Object.keys(config.profiles).some(name => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))) {
    throw new CliError('CONFIG_INVALID', 'Invalid profile configuration');
  }
  return config;
}

export function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:\/\/[^\s\\/?#@]+\/?$/i.test(value) || !url.hostname || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new CliError('CONFIG_INVALID', 'origin must contain only HTTP or HTTPS scheme, host and port');
  }
}

export async function credentials(override: string | undefined, allowHttp: boolean, options: { config?: string; profile?: string } = {}): Promise<{ origin: string; token?: string; profile?: string; source?: string; revision?: string; writes?: Profile['writes'] }> {
  const path = configPath(options.config);
  const selected = options.profile ?? process.env.GITEA_AXI_PROFILE;
  const fields = ['ORIGIN', 'TOKEN_ORIGIN', 'TOKEN', 'ALLOW_INSECURE_HTTP'] as const;
  const hasEnv = fields.some(field => process.env['GITEA_AXI_' + field] !== undefined);
  let profile: unknown;
  let profileName = 'environment';
  let revision = 'environment';
  if (!selected && hasEnv) {
    let token: unknown;
    try { token = JSON.parse(process.env.GITEA_AXI_TOKEN ?? 'null'); } catch { /* Schema reports only the field name. */ }
    const http = process.env.GITEA_AXI_ALLOW_INSECURE_HTTP;
    if (http !== undefined && http !== 'true' && http !== 'false') throw new CliError('CONFIG_INVALID', 'allowInsecureHttp must be true or false');
    profile = { origin: process.env.GITEA_AXI_ORIGIN, tokenOrigin: process.env.GITEA_AXI_TOKEN_ORIGIN, token,
      allowInsecureHttp: http === 'true' };
  } else if (existsSync(path)) {
    const config = await readConfig(path);
    const names = Object.keys(config.profiles);
    const name = selected ?? config.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
    if (!name) throw new CliError(names.length ? 'PROFILE_AMBIGUOUS' : 'PROFILE_REQUIRED', 'Select a profile');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || !Object.hasOwn(config.profiles, name)) throw new CliError('PROFILE_NOT_FOUND', 'Selected profile was not found');
    profile = config.profiles[name];
    profileName = name;
    revision = process.env.GITEA_AXI_CREDENTIAL_REVISION ?? String((await stat(path, { bigint: true })).mtimeNs);
  } else if (selected || options.config || process.env.GITEA_AXI_CONFIG) {
    throw new CliError('PROFILE_NOT_FOUND', 'Selected profile configuration was not found');
  } else if (override) {
    const origin = canonicalOrigin(override);
    if (origin.startsWith('http:') && !allowHttp) throw new CliError('USAGE', 'HTTP requires --allow-insecure-http for the explicit --origin', 2);
    return { origin };
  } else {
    throw new CliError('AUTH_REQUIRED', 'Select a configured profile or an explicit anonymous --origin');
  }
  if (!validate(profile)) throw new CliError('CONFIG_INVALID', 'Invalid profile field: ' + (validate.errors?.[0]?.instancePath || 'token/origin'));
  const origin = canonicalOrigin(profile.origin);
  if (origin !== canonicalOrigin(profile.tokenOrigin) || (override && canonicalOrigin(override) !== origin)) {
    throw new CliError('AUTH_BINDING_MISMATCH', 'origin must match tokenOrigin before resolving token');
  }
  if (origin.startsWith('http:') && !profile.allowInsecureHttp) throw new CliError('CONFIG_INVALID', 'HTTP requires allowInsecureHttp on the selected profile');
  let token: string;
  if ('env' in profile.token) token = process.env[profile.token.env] ?? '';
  else {
    if (!isAbsolute(profile.token.file) || /^\\\\/.test(profile.token.file)) throw new CliError('CONFIG_INVALID', 'token file must be an absolute local path');
    token = (await readPrivateFile(profile.token.file, true)).replace(/^\uFEFF/, '').trimEnd();
    revision += ':' + String((await stat(profile.token.file, { bigint: true })).mtimeNs);
  }
  if (!token) throw new CliError('AUTH_REQUIRED', 'token reference is empty');
  secrets.push(token);
  if (/[\r\n]/.test(token)) throw new CliError('CONFIG_INVALID', 'token must be a single line');
  return { origin, token, profile: profileName, revision, source: 'env' in profile.token ? 'env:' + profile.token.env : 'file:' + profile.token.file,
    ...(profile.writes ? { writes: profile.writes } : {}) };
}
