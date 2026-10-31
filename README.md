# gitea-axi

An agent CLI for Gitea, currently implementing the S1.1 packaged repository read.
It returns repository identity and default branch alongside server version and specification metadata.
This stage has offline fake evidence only; live Gitea access, credentials and Artium execution remain unverified.

Use Node 24.14.0 (minimum 24.11.0) and npm 11.9.0.
Dependencies are exact in `package.json` and transitive versions are locked in `package-lock.json`.
Setup uses a prepared npm cache and performs no registry requests:

```sh
npm ci --offline --ignore-scripts
npm run build
node dist/cli.js repo view --help
node scripts/verify.mjs --task S1.1
node scripts/check.mjs --offline
```

The verification driver builds and packs the CLI, installs that tarball offline into an empty temporary prefix and invokes its installed bin from outside the source tree.
Only the local HTTP fake replaces the vendor boundary.
The driver checks AC-001, AC-002 and AC-004, package contents, registry freshness, type checking, linting and refusal cases.
It prints the path to a report containing exact process invocations, assertions, runtime pins and the package SHA-256.
Set `GITEA_AXI_REPORT` to retain the report at a chosen path.
The default report goes to a unique file in the OS temporary directory; temporary installation files are removed.

Command syntax:

```text
gitea-axi repo view --repo OWNER/NAME --origin https://gitea.example.test
```

The origin and repository must be explicit in S1.1.
HTTP requires `--allow-insecure-http` for that selected origin.
The tool reads no developer credentials and follows no redirects.
Output uses TOON; structured errors use stdout, with exit 1 for operational failures and exit 2 for usage errors.
Requests have a 30-second timeout and a 2,000,000-byte response limit.

`src/registry.ts` owns command metadata, help and the host inventory.
`npm run generate` generates those artifacts plus the consumed response schema and route types from the retained Swagger.
`npm run generate:check` rejects stale artifacts.
`evidence/README.md` records retained source paths, provenance and hashes.
Profiles, dashboard, additional reads and the real local Artium path belong to later plan tasks.
