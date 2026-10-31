# gitea-axi

An agent CLI for Gitea repository, issue and pull request reads with private credential profiles.
It includes a bounded repository dashboard, list and detail views, reviews, checks, diffs and classified raw GET requests.
Verification uses offline fakes only; live Gitea access remains unverified.

`run list` reads Gitea 1.23.4 Actions task summaries with workflow, branch, status, event and commit filters across bounded pages.
`--user` and unmapped fields fail explicitly.
Task IDs and status strings do not establish run identity, job conclusions or terminal run results.
All seven run commands and five workflow commands remain discoverable with `--help`.
Run detail, watch, logs, downloads and workflow controls report explicit capability gaps.
Mutating controls remain pending on the shared write gate.
The retained 1.24.0 workflow, artifact and job-log routes are investigation candidates, not supported target operations.

`search issues|prs|repos|commits "text"` searches at most 20 pages and 1000 candidates per collection, then filters, sorts and applies the total output limit (default 1000).
Issue and PR searches support exact arbitrary author and assignee names and comma-separated label ANY matching; an unknown label alone matches nothing.
Use `--repo OWNER/NAME` for repository scope or `--owner OWNER` for issue, PR and repository searches.
Repository search supports `--language` and integer `--stars` comparisons.
Commit search requires `--repo`, resolves `--revision` (default repository branch) to a SHA and discloses that ancestry scope.
Results disclose truncation and scope; totals are unknown when candidate collection is incomplete.
Queries accept plain text; unsupported qualifiers, review predicates and `authorAssociation` fail explicitly.
`search code` remains unresolved because repository contents cannot substitute for indexed code search.

Run the S5 installed-package fake journeys with `node scripts/verify.mjs --task S5.1` and `node scripts/verify.mjs --task S5.2`.
`npm test` includes these journeys under a process preload that denies outbound connections except loopback.
Artium journeys are opt-in via `GITEA_AXI_ARTIUM_ROOT` and `GITEA_AXI_ARTIUM_MANIFEST`, with an explicit skip reason when absent.
Native Windows and live commissioning remain pending.

Use Node 24.14.0 (minimum 24.11.0) and npm 11.9.0.
Dependencies are exact in `package.json` and transitive versions are locked in `package-lock.json`.
Install the public npm package:

```sh
npm install -g @knowttl/gitea-axi
gitea-axi --version
```

The executable is `gitea-axi`.
To build from source:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js repo view --help
node scripts/verify.mjs --task S1.1
```

The verification driver builds and packs the CLI, installs that tarball into an empty temporary prefix and invokes its installed bin from outside the source tree.
Dependency installation can access npm; Gitea requests use only local fakes.
Only the local HTTP fake replaces the vendor boundary.
The S1.1 driver checks AC-001, AC-002 and AC-004, package contents, registry freshness, type checking, linting and refusal cases.
Its report contains exact process invocations, assertions, runtime pins and the package SHA-256.
Each driver prints its report path.
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

Anonymous reads require an explicit origin; repository selection follows the rules below.
Anonymous HTTP reads require `--allow-insecure-http` for that selected origin.
The tool follows no redirects and never imports tea or Git credentials.
Output uses TOON; structured errors use stdout, with exit 1 for operational failures and exit 2 for usage errors.
Business reads share a 30-second deadline, except check watches use their explicit timeout; each request has a 2,000,000-byte response limit.
`repo view` instead gives each of its server version, specification and repository requests a separate 30-second timeout.
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
Raw requests accept `api [GET] <relative-path>` for JSON metadata and refuse absolute URLs, traversal, secret query fields, credential-bearing routes, administrative routes, text or binary downloads and unclassified routes.
HTTP 401, 403 and ambiguous 404 responses remain distinct failures, and rate-limit retry hints never cause automatic retries.

`src/registry.ts` owns command metadata, help and the host inventory.
`npm run generate` generates those artifacts plus the consumed response schemas, route types and classified raw-route registry from the retained Swagger.
`npm run generate:check` rejects stale artifacts.
`evidence/README.md` records retained source paths, provenance and hashes.
Credentialed reads use the shipped `axi-credential.schema.json` contract.
The config file is `$XDG_CONFIG_HOME/gitea-axi/config.json`, otherwise `~/.config/gitea-axi/config.json` on Linux, and `%APPDATA%\gitea-axi\config.json` on Windows.
`--config` takes precedence over `GITEA_AXI_CONFIG`, and `--profile` takes precedence over `GITEA_AXI_PROFILE`.
`--config` requires an absolute path.
The config object contains `version: 1`, a `profiles` object keyed by profile name, and an optional `defaultProfile` name.
Without `--profile` or `GITEA_AXI_PROFILE`, setting any environment-profile field selects the environment profile instead of the config file; incomplete profiles are refused.
File selection uses the explicit profile, otherwise the file's `defaultProfile` or its sole profile.
Multiple file profiles without a selection or default are refused.
On Linux, the config file must be owned by the invoking account and must not be group- or world-writable.
Config files and file SecretRefs must be regular files; symlinks are refused.
See [the credential schema](axi-credential.schema.json) for profile fields and env/file SecretRef shapes.
`origin` and `tokenOrigin` must identify the same canonical origin.
Inline tokens and secret arguments are refused.
Resolved credentials are redacted from response and error string values before TOON serialization, including their JSON-escaped and URL-encoded forms.
Redaction also masks recognized secret fields, secret query values, URL credentials, JWTs, private keys and account keys.
The complete environment profile uses `GITEA_AXI_ORIGIN`, `GITEA_AXI_TOKEN_ORIGIN` and a JSON SecretRef in `GITEA_AXI_TOKEN`.
Set `GITEA_AXI_ALLOW_INSECURE_HTTP=true` to permit HTTP for that environment profile; only the exact values `true` and `false` are accepted.
HTTP requires `allowInsecureHttp: true` on that exact profile; a runtime origin override cannot reuse the token for another origin.
Keep file references owned by the invoking account with mode 0600 on Linux.
Windows file protection is PENDING; file SecretRefs are refused until native ACL verification is available.
Use env SecretRefs on Windows.
`auth status` resolves the selected credentials locally; its `authenticated` field reports token availability without checking the server.
`doctor` checks the current identity through Gitea's `/api/v1/user` endpoint.

Stock Artium support is not claimed.
Full profile management and native Windows permission verification remain pending.

`npm test` runs the installed-package checks with local Gitea fakes for S1.1 and S2.1 through S2.4.
Each S2 task also has an independent entrypoint, for example `node scripts/verify.mjs --task S2.3`.
The S2 fixtures contain synthetic non-empty records authored against the retained schemas, with independent expected projections for supported selected PR fields and explicit capability refusals for the remaining fields.
Set `GITEA_AXI_ARTIUM_ROOT` to a built admission fixture containing this package's read inventory to repeat business reads through a real local Artium server, client, credential writer and runner.
Set `GITEA_AXI_ARTIUM_MANIFEST` to that fixture's frozen manifest; the S2 proof records its revision and manifest digest alongside the tested source head and package digest.
The S2 driver reports whether Artium was selected; a standalone pass does not establish hosted admission.
Hosted CLI behavior scenarios must execute and match the expected exit code and standalone result; expected admission refusals are checked separately for their exact error code and recorded in `hostedRefusals`.
The fixture must admit item positionals, raw GET paths and the declared read flags while continuing to block credential and endpoint overrides.
