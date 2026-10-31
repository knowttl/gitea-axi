import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { Repository, ServerVersion } from './vendor.generated.js';
import { routes } from './vendor.generated.js';
import { get } from './transport.js';
import { CliError } from './error.js';

interface Specification { info: { version: string }; paths: Record<string, object> }
const schemas = JSON.parse(readFileSync(new URL('../schemas/responses.json', import.meta.url), 'utf8'));
const ajv = new Ajv();
const validateRepository = ajv.compile<Repository>(schemas.Repository);
const validateVersion = ajv.compile<ServerVersion>(schemas.ServerVersion);
const validateSpecification = ajv.compile<Specification>(schemas.Specification);

export async function readRepository(origin: string, repo: string) {
  const version = await get(origin, routes.version);
  if (!validateVersion(version)) throw new CliError('INVALID_RESPONSE', 'Gitea version response is invalid');
  const specification = await get(origin, routes.specification);
  if (!validateSpecification(specification)) {
    throw new CliError('INVALID_RESPONSE', 'Gitea specification response is invalid');
  }
  const [owner, name] = repo.split('/') as [string, string];
  const path = routes.repository.replace('{owner}', encodeURIComponent(owner)).replace('{repo}', encodeURIComponent(name));
  const repository = await get(origin, path);
  if (!validateRepository(repository) || repository.full_name !== repo || !repository.default_branch) {
    throw new CliError('INVALID_RESPONSE', 'Gitea repository identity or default branch is invalid');
  }
  return {
    server: {
      version: version.version,
      specification_version: specification.info.version,
      specification_paths: Object.keys(specification.paths).length,
    },
    repository: {
      id: repository.id,
      full_name: repository.full_name,
      default_branch: repository.default_branch,
    },
  };
}
