# gitea-axi

An agent CLI for Gitea repository, issue and pull request reads with private credential profiles.
It includes a bounded repository dashboard, list and detail views, reviews, checks, diffs and classified raw GET requests.
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
gitea-axi --repo OWNER/NAME
gitea-axi issue list --repo OWNER/NAME --state open --limit 2
gitea-axi pr view 7 --repo OWNER/NAME --reviews --checks
gitea-axi pr view 7 --repo OWNER/NAME --fields number,title,headRefOid
gitea-axi pr checks 7 --repo OWNER/NAME --watch --timeout 30
gitea-axi api GET repos/OWNER/NAME
gitea-axi auth status
gitea-axi profile list
gitea-axi config path
gitea-axi doctor
```

Anonymous reads require an explicit origin and repository.
Anonymous HTTP reads require `--allow-insecure-http` for that selected origin.
The tool follows no redirects and never imports tea or Git credentials.
Output uses TOON; structured errors use stdout, with exit 1 for operational failures and exit 2 for usage errors.
Requests have a 30-second timeout and a 2,000,000-byte response limit.
An explicit repository wins over a matching local origin remote; a remote never changes the selected profile.
Hosted repository reads require an explicit repository.
Lists default to 30 returned records and bound collection scans to 20 pages or 1000 unique records.
Issue and PR lists filter before globally sorting the collected records and applying the return limit.
Milestone selectors use exact names, including numeric-looking names.
List output distinguishes unknown vendor totals from known totals and reports continuation and truncation.
Dashboard sections report permission failures as partial results.
Bodies default to 1000 characters, diffs to 10000 characters, and rendered output to 100000 characters.
`--full` expands bodies and diffs within the response and output ceilings.
`pr checks` exits 8 for pending checks and 1 for failed or absent checks; watches require an explicit deadline and accept cancellation.
`--fields` refuses unknown names and fields without an evidenced Gitea equivalent, and cannot combine with detail expansion flags.
Raw requests accept `api [GET] <relative-path>` and refuse absolute URLs, traversal, secret query fields, credential-bearing routes and unclassified routes.
HTTP 401, 403 and ambiguous 404 responses remain distinct failures, and rate-limit retry hints never cause automatic retries.

`src/registry.ts` owns command metadata, help and the host inventory.
`npm run generate` generates those artifacts plus the consumed response schema and route types from the retained Swagger.
`npm run generate:check` rejects stale artifacts.
`evidence/README.md` records retained source paths, provenance and hashes.
Credentialed reads use the shipped `axi-credential.schema.json` contract.
The config file is `$XDG_CONFIG_HOME/gitea-axi/config.json`, otherwise `~/.config/gitea-axi/config.json` on Linux, and `%APPDATA%\gitea-axi\config.json` on Windows.
`--config` takes precedence over `GITEA_AXI_CONFIG`, and `--profile` takes precedence over `GITEA_AXI_PROFILE`.
The config object contains `version: 1`, a `profiles` object keyed by profile name, and an optional `defaultProfile` name.
Without `GITEA_AXI_PROFILE`, setting any environment-profile field selects the environment profile instead of the config file; incomplete profiles are refused.
Otherwise the file's `defaultProfile` or its sole profile is selected.
Multiple file profiles without a selection or default are refused.
On Linux, the config file must be owned by the invoking account and must not be group- or world-writable.
Each profile contains `origin`, an equal `tokenOrigin`, and `token` as either `{"env":"TOKEN_VARIABLE"}` or `{"file":"/absolute/private/token"}`.
Inline tokens and secret arguments are refused.
Resolved credentials are redacted from response and error string values before TOON serialization, including their JSON-escaped and URL-encoded forms.
The complete environment profile uses `GITEA_AXI_ORIGIN`, `GITEA_AXI_TOKEN_ORIGIN` and a JSON SecretRef in `GITEA_AXI_TOKEN`.
Set `GITEA_AXI_ALLOW_INSECURE_HTTP=true` to permit HTTP for that environment profile; only the exact values `true` and `false` are accepted.
HTTP requires `allowInsecureHttp: true` on that exact profile; a runtime origin override cannot reuse the token for another origin.
Keep file references owned by the invoking account with mode 0600 on Linux.
Windows file protection is PENDING; file SecretRefs are refused until native ACL verification is available.
Use env SecretRefs on Windows.

Stock Artium support is not claimed.
Full profile management and native Windows permission verification remain pending.

`npm test` runs the installed-package offline checks for S1.1 and S2.1 through S2.4.
Each S2 task also has an independent entrypoint, for example `node scripts/verify.mjs --task S2.3`.
The S2 fixtures contain synthetic non-empty records authored against the retained schemas, with independent expected projections for all 46 selected PR fields.
Set `GITEA_AXI_ARTIUM_ROOT` to a built admission fixture containing this package's read inventory to repeat business reads through a real local Artium server, client, credential writer and runner.
Set `GITEA_AXI_ARTIUM_MANIFEST` to that fixture's frozen manifest; the S2 proof records its revision and manifest digest alongside the tested source head and package digest.
The S2 driver reports whether Artium was selected; a standalone pass does not establish hosted admission.
The fixture must admit item positionals, raw GET paths and the declared read flags while continuing to block credential and endpoint overrides.
