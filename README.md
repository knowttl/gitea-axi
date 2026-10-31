# gitea-axi

An agent CLI for Gitea with a packaged repository read and a private credential profile contract.
It returns repository identity and default branch alongside server version and specification metadata.
Verification uses offline fakes only; live Gitea access remains unverified.

Use Node 24.14.0 (minimum 24.11.0) and npm 11.9.0.
Dependencies are exact in `package.json` and transitive versions are locked in `package-lock.json`.
Setup uses a prepared npm cache and performs no registry requests:

```sh
npm ci --offline --ignore-scripts
npm run build
node dist/cli.js repo view --help
node scripts/verify.mjs --task S1.1
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

Anonymous reads require an explicit origin and repository.
HTTP requires `--allow-insecure-http` for that selected origin.
The tool follows no redirects and never imports tea or Git credentials.
Output uses TOON; structured errors use stdout, with exit 1 for operational failures and exit 2 for usage errors.
Requests have a 30-second timeout and a 2,000,000-byte response limit.

`src/registry.ts` owns command metadata, help and the host inventory.
`npm run generate` generates those artifacts plus the consumed response schema and route types from the retained Swagger.
`npm run generate:check` rejects stale artifacts.
`evidence/README.md` records retained source paths, provenance and hashes.
Credentialed reads use the shipped `axi-credential.schema.json` contract.
The config file is `$XDG_CONFIG_HOME/gitea-axi/config.json`, otherwise `~/.config/gitea-axi/config.json` on Linux, and `%APPDATA%\gitea-axi\config.json` on Windows.
`GITEA_AXI_CONFIG` selects an explicit file and `GITEA_AXI_PROFILE` selects its profile.
Each profile contains `origin`, an equal `tokenOrigin`, and `token` as either `{"env":"TOKEN_VARIABLE"}` or `{"file":"/absolute/private/token"}`.
Inline tokens and secret arguments are refused.
The complete environment profile uses `GITEA_AXI_ORIGIN`, `GITEA_AXI_TOKEN_ORIGIN` and a JSON SecretRef in `GITEA_AXI_TOKEN`.
HTTP requires `allowInsecureHttp: true` on that exact profile; a runtime origin override cannot reuse the token for another origin.
Keep file references owned by the invoking account with mode 0600 on Linux.
Windows file protection is PENDING; file SecretRefs are refused until native ACL verification is available.
Use env SecretRefs on Windows.

S1.2 uses an unmerged local Artium fixture based on revision `3cfc65afc2d7c1a0f50d2f6e02dc2ee13d6fd7e8`, with the reviewed credential-support delta applied.
Set `GITEA_AXI_ARTIUM_ROOT` to that built fixture and `GITEA_AXI_HOST_GATE_REPORT` to its external verification receipt, then run `node scripts/verify.mjs --task S1.2` or both tasks with `node scripts/check.mjs --offline`.
The driver launches the real local server and public client, executes the installed tarball, and tests injected credentials, admission, private files, redaction, redirects, timeout, cancellation, output bounds, audit and cleanup.
The receipt must record successful `check`, `test:containers` and `test:runner-container` gates with nonzero scenario counts, the completed host review bound to its full commit SHA, and `candidate: {inputs: buildInputs(), output: digest(['dist/'])}` from Artium's `scripts/build-inputs.mjs`.
The host review record preserves the pipeline outcome separately from the direct regression and container results.
It also binds the approved test-only revision follow-up; the driver checks that subsequent changes are confined to the fixture test.
The driver rejects missing gates or evidence for different host inputs or compiled output.
Private hygiene checking belongs to the fixture maintainer, who checks the candidate and delta before delivery.
Stock Artium support is not claimed.
Full profile management, native Windows permission verification, dashboard and additional reads belong to later plan tasks.
