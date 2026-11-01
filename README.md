# gitea-axi

An agent CLI for Gitea repository workflows with private credential profiles.
It includes a bounded repository dashboard, detailed reads, Actions task summaries, bounded search, repository, release, issue, label and pull request mutations, and classified raw API requests.
Verification uses offline fakes only; live Gitea access remains unverified.

`run list` reads Gitea 1.23.4 Actions task summaries with workflow, branch, status, event and commit filters across bounded pages.
`--user` and unmapped fields fail explicitly.
Task IDs and status strings do not establish run identity, job conclusions or terminal run results.
All seven run commands and five workflow commands remain discoverable with `--help`.
Run detail, watch, logs, downloads and workflow controls report explicit capability gaps.
Mutating run and workflow controls remain unsupported pending contract commissioning.
The retained 1.24.0 workflow, artifact and job-log routes are investigation candidates, not supported target operations.

`search issues|prs|repos|commits "text"` searches at most 20 pages and 1000 candidates per collection, then filters, sorts and applies the total output limit (default 1000).
Issue and PR searches support exact arbitrary author and assignee names and comma-separated label ANY matching; an unknown label alone matches nothing.
Use `--repo OWNER/NAME` for repository scope or `--owner OWNER` for issue, PR and repository searches.
Repository search supports `--language` and integer `--stars` comparisons.
Commit search requires `--repo`, resolves `--revision` (default repository branch) to a SHA and discloses that ancestry scope.
Results disclose truncation and scope; totals are unknown when candidate collection is incomplete.
Queries accept plain text; unsupported qualifiers, review predicates and `authorAssociation` fail explicitly.
`search code` remains unresolved because repository contents cannot substitute for indexed code search.

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
The S1, S2, S3 and S4 drivers print their report paths.
Set `GITEA_AXI_REPORT` to retain their reports at a chosen path.
Their default reports go to unique files in the OS temporary directory; temporary installation files are removed.
For S5, set `GITEA_AXI_REPORT_DIR` to an existing directory to retain `S5.1.json` or `S5.2.json`; otherwise only a console summary is emitted.

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
Lists default to 30 returned records, except `run list` and `release list` default to 10; collection scans are bounded to 20 pages or 1000 unique records.
Issue and PR lists filter before globally sorting the collected records and applying the return limit.
Milestone selectors use exact names, including numeric-looking names.
List output distinguishes unknown vendor totals from known totals and reports continuation and truncation.
Dashboard sections report permission failures as partial results.
Issue and PR bodies default to 1000 characters, diffs to 10000 characters, and rendered output to 100000 characters.
`--full` expands bodies and diffs within the response and output ceilings.
`pr checks` exits 8 for pending checks and 1 for failed or absent checks; watches require an explicit deadline and accept cancellation.
`--fields` refuses unknown names and fields without an evidenced Gitea equivalent, and cannot combine with detail expansion flags.
Raw reads accept `api [GET] <relative-path>` for JSON metadata and refuse absolute URLs, traversal, secret query fields, credential-bearing routes, administrative routes, text or binary downloads and unclassified routes.
Encoded slash and backslash separators are refused in API paths; encoded query text remains supported.
HTTP 401, 403 and ambiguous 404 responses remain distinct failures, and rate-limit retry hints never cause automatic retries.

Issue mutations include `create`, `edit`, `close`, `reopen`, `comment`, `delete`, `pin` and `unpin`.
Label mutations include `create`, `edit` and `delete`; edit and delete accept an exact label name or ID.
Create accepts repeatable `--assignee` and `--label` names and an exact `--milestone` title.
Edit uses repeatable `--add-assignee`, `--remove-assignee`, `--add-label` and `--remove-label`, preserving unrelated memberships.
Create, edit and comment accept `--body` or `--body-file`; body files must be owned, mode 0600, and at most 1000000 bytes.
Use `--body-file -` for bounded stdin.
Close accepts an optional `--comment`, recorded as a separate write step.
GitHub-only type, project, close-reason and duplicate flags are refused before mutation.
Create, edit and comment accept repeatable `--attach FILE` with an additional attachment operation grant.
Comment attachments bind the newly created comment ID; creation attachments bind the newly created parent identity.
An attachment failure reports the existing parent ID and number for reconciliation without repeating creation.
Label colours normalize to six lowercase hexadecimal digits, and renaming preserves the label ID.
Issue and label deletion require a complete collection and at least one remaining control record before dispatch.

Pull request mutations include `create`, `edit`, `close`, `reopen`, `comment`, `update-branch` and `merge`.
Creation requires explicit `--title`, `--base` and `--head` branch names in the selected repository.
Cross-repository heads, draft and project inputs remain unavailable.
Create accepts repeatable `--reviewer` user names and `--team-reviewer` team names, plus issue-style assignees, labels and milestone selectors.
Edit accepts `--base`, text fields and assignee/label deltas, plus repeatable `--add-reviewer`, `--remove-reviewer`, `--add-team-reviewer` and `--remove-team-reviewer` deltas.
Existing reviewers and teams remain present unless explicitly removed.
Reviewer edits run before field edits, so an upstream reviewer rejection leaves requested field edits unapplied.
Create requires the `repoCreatePullRequest` grant.
When reviewers are requested, create resolves reviewer user identities first, then requests reviewers after creation as a separate guarded step requiring the additional `repoCreatePullReviewRequests` grant.
If the reviewer step fails after creation, the error reports the created PR ID and number for reconciliation without retrying.
Close with `--comment` records closure and comment as separate steps and reports partial outcomes without retrying.
Successful writes verify the same PR identity, expected fields and memberships through fresh reads.
Update-branch verifies that the resulting head contains both its previous head and base commits; conflicts never report completion.
Merge requires exactly one of `--merge`, `--squash`, `--rebase` or `--method merge|squash|rebase`, and a full `--match-head-commit` SHA.
It sends the vendor `head_commit_id` precondition and verifies the closed, merged PR, base branch tip and final commit topology.
Merge commits retain the previous base and checked head as parents; squash uses one new commit on the previous base; rebase verifies the rewritten linear chain and original commit messages.
These are offline protocol and topology checks, not live vendor atomicity or content-equivalence commissioning.
`--auto`, `--admin` and `--delete-branch` each report a capability gap because their semantics remain unverified.
`pr review` validates exactly one of `--approve`, `--request-changes` or `--comment`, then refuses before posting.
C043 and CX-007 remain unresolved: the retained contract does not establish review wire events or atomic stale-head refusal.
Supplying `--match-head-commit` does not enable reviews or weaken this refusal to a warning.

Repository mutations include API-only `repo create NAME|OWNER/NAME`, `repo edit` and `repo fork`.
Create requires exactly one of `--public` or `--private`, and accepts `--description` and `--template OWNER/NAME`.
An unqualified name uses the authenticated user; another owner selects an organization.
The operation grants are `createCurrentUserRepo`, `createOrgRepo`, `generateRepo`, `repoEdit` and `createFork` respectively.
Template creation uses the generate endpoint with Git content enabled, then compares the complete resulting Git tree with the template.
Templates containing `.gitea/template` are refused before mutation with `CAPABILITY_GAP`: `Transforming templates not yet supported`.
Edit supports `--description`, `--visibility public|private`, `--default-branch`, `--enable-issues` and `--enable-wiki`.
Boolean flags accept explicit `=true` and `=false`, including disabling issues or wiki.
Fork takes a source through `--repo` or a positional OWNER/NAME and optionally `--org` for the destination.
Verification checks the destination identity, requested fields and fork parent.
Internal visibility and workspace flags (`--source`, `--push`, `--remote`, `--clone`) refuse before mutation.
`--push` and `--remote` require `--source`; local workspace publishing remains deferred.

Release commands include `list`, `view TAG`, `create TAG`, `edit TAG` and `delete TAG` with `--repo OWNER/NAME`.
Exact release and tag lookups require complete collections within the collection scan bounds above; incomplete lookups refuse.
Slash-containing release tags and branch refs are supported without weakening API path separator protections.
List supports `--exclude-drafts` and `--exclude-pre-releases` and returns compact tag, title and publication flags.
View shows up to 1500 note characters; `--full` expands this to 80000 within the output ceiling.
Create and edit accept `--title`, `--notes` (or `--body`), `--notes-file` (or `--body-file`), `--draft` and `--prerelease`, preserving explicit false values.
File inputs share the protected body-file contract; stdin uses `-`.
Create accepts `--target`, `--verify-tag` and `--notes-from-tag` for an existing annotated tag's message.
The grants are `repoCreateRelease`, `repoEditRelease` and `repoDeleteRelease`.
Deletion verifies release absence, preservation of other releases and the independently observed tag state; it does not delete a tag.
`--latest`, discussion settings and asset positionals refuse before creation.
An existing or uncertain release cannot trigger an automatic duplicate create.

`issue upload NUMBER`, `pr upload NUMBER` and `release upload TAG` accept repeatable `--file FILE` and optional `--content-type` (default `application/octet-stream`).
Create and edit also accept repeatable `--attach FILE`; all uploads share the write policy below.
The attachment grants are `issueCreateIssueAttachment`, `issueCreateIssueCommentAttachment` and `repoCreateReleaseAttachment`.
Uploads bind exact bytes, MIME type and basename to confirmation, then verify new attachment identities, names and sizes through metadata reads.
Each file is limited to 10000000 bytes; symlinks, unsafe portable basenames and duplicate names are refused.

`issue download NUMBER`, `pr download NUMBER` and `release download TAG` select attachments with repeatable `--pattern` globs (`*` and `?`, default `*`) or exact `--asset-id`.
Use an existing `--dir`, or `--output FILE` for exactly one attachment.
`--sha256 DIGEST` verifies an independently known digest for one selected file; `--content-type TYPE` requires that MIME type.
Downloads verify metadata identity again before requesting `/attachments/UUID` on the selected origin, independently bound to 10000000 bytes per response.
This binary route is [source-derived](evidence/binary-transfer-contract.md); private-token compatibility, direct object storage and live commissioning remain pending.
Metadata URLs are never used as transport authority, and every redirect is refused.
Files are written privately and published only after complete size and optional digest verification.
Existing files require explicit `--clobber`; traversal, symlinks and duplicate basenames refuse.
No matches is an explicit error; partial transfers identify completed attachment IDs and retain only completed files.

`secret list|set|delete` and `variable list|set|delete` select a repository with `--repo OWNER/NAME` or an organization with `--org NAME`.
Set and delete take one name, normalized to uppercase for repository and organization operations, including raw secret writes; environment scopes are unsupported.
`secret set NAME --input -` reads the exact value from protected stdin; `--input FILE` uses an owned mode 0600 file, bounded to 1000000 bytes.
Secret values are write-only: previews omit them, mutation response bodies are discarded, and verification reads name metadata only.
Secret listing returns names without invented timestamps; a successful set confirms name existence, not independently commissioned value consumption.
Variable listing returns names and stored values, including empty strings.
`variable set NAME --body VALUE` or `--input FILE|-` creates absent variables and updates existing ones, preserving empty strings and verifying the exact value and unrelated variables.
Use `updateRepoSecret`, `deleteRepoSecret`, `updateOrgSecret` or `deleteOrgSecret` for secret grants.
Variable grants are `createRepoVariable`, `updateRepoVariable`, `deleteRepoVariable` and their organization counterparts `createOrgVariable`, `updateOrgVariable`, `deleteOrgVariable`.

`release create --generate-notes` computes notes locally from exact commit ancestry and declares a `local-composite` result with `from`, `to` and commit identities.
`--notes-start-tag` excludes that tag and all its ancestors, requires it to be an ancestor of the target, and otherwise defaults to the most recent nondraft release's tag.
With no previous release, notes include the complete target ancestry.
The traversal includes merged branches, is bounded to 1000 commits per ancestry, and refuses incomplete ranges.
For a new tag, the generated target is pinned to its resolved SHA in the write payload.
`--fail-on-no-commits` refuses an empty generated range; supplied notes precede generated notes.
These notes do not claim Gitea's native release-note generation or GitHub formatting parity.

Writes are disabled unless `--allow-write` names every exact vendor operation needed by the command.
A profile's optional `writes` object can narrow this grant with `allowWrites` and an `operations` array.
When set, `GITEA_AXI_READ_ONLY` refuses writes unless its value is exactly `false`.
A hosted operation allow-list and read-only policy always take precedence over command-line grants.
Preview and confirm the same arguments:

```sh
gitea-axi issue create --repo OWNER/NAME --title 'Fix login' --body 'Reproduction steps' --allow-write issueCreateIssue --preview
gitea-axi issue create --repo OWNER/NAME --title 'Fix login' --body 'Reproduction steps' --allow-write issueCreateIssue --confirm CONFIRMATION_ID
gitea-axi issue close 42 --repo OWNER/NAME --comment 'Resolved' --allow-write issueEditIssue,issueCreateComment --preview
gitea-axi label create --repo OWNER/NAME --name bug --color ff0000 --allow-write issueCreateLabel --preview
```

The preview identifies the exact operations, payload and current preconditions without sending a mutation.
Confirmation binds the credential revision, origin, target, operations, canonical payload and preconditions.
Changing any binding requires a fresh preview.
For issues that remain present, successful named writes verify identity and the expected final title, body, assignees, labels, milestone and state through fresh reads.
Pin changes verify the complete expected pin membership; deletion verifies absence of the selected identity and preservation of all remaining records.
A mismatched or failed verification reports an unknown outcome.

Raw POST, PUT, PATCH and DELETE requests use this same policy and journal.
Use a positional method or `-X METHOD`, repeatable `--field key=value` for typed numbers, booleans and null, or `--raw-field key=value` for strings.
Protected JSON `--input FILE` and `--input -` are alternatives to argv fields, with the same 1000000-byte bound.
Raw secret PUT requests require protected JSON `--input` containing only a string `data` field.
Secret `--field data=...` and `--raw-field data=...` refuse before dispatch without echoing the value.
Other credential-bearing routes remain refused.
Integer route parameters on writes require canonical decimal spelling, so an issue index such as `01` is refused.

The journal defaults to `$XDG_STATE_HOME/gitea-axi/writes.log`, otherwise `~/.local/state/gitea-axi/writes.log` on Linux.
`GITEA_AXI_WRITE_LOG` selects another absolute path; private confirmation receipts live beside it in `write-receipts`.
The journal records hashes, operation identities and step states, without credentials or request bodies.
Each attempt is persisted before dispatch.
Timeouts, interrupted requests and partial failures return `WRITE_OUTCOME_UNKNOWN`, completed/pending step information and an exact `gitea-axi write reconcile CONFIRMATION_ID` command.
Reconciliation performs complete metadata reads for inspection and never repeats a mutation.
An unresolved dispatched attempt cannot be replayed by reusing its confirmation or obtaining another preview for the same effect.
Replay guards also treat repository owner and repository name case variants as the same identity.
Keep its private receipts until the outcome has been investigated.
Native Windows write protection and live write commissioning remain unverified; Windows writes are refused.

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

`npm test` runs the installed-package checks with local Gitea fakes for S1.1, S2.1 through S2.4, S3.1 through S3.5, S4.1 through S4.3, S5.1 and S5.2 under an inherited outbound network guard.
Each S2 task also has an independent entrypoint, for example `node scripts/verify.mjs --task S2.3`.
Run each S3 journey independently with `node scripts/verify.mjs --task S3.1`, `S3.2`, `S3.3`, `S3.4` or `S3.5`.
Run the release journey with `node scripts/verify.mjs --task S4.1`.
Run attachments with `node scripts/verify.mjs --task S4.2` and protected values with `node scripts/verify.mjs --task S4.3`.
Run the S5 journeys independently with `node scripts/verify.mjs --task S5.1` and `node scripts/verify.mjs --task S5.2`.
The S2 fixtures contain synthetic non-empty records authored against the retained schemas, with independent expected projections for supported selected PR fields and explicit capability refusals for the remaining fields.
Set `GITEA_AXI_ARTIUM_ROOT` to a built admission fixture containing this package's read inventory to repeat business reads through a real local Artium server, client, credential writer and runner.
Set `GITEA_AXI_ARTIUM_MANIFEST` to that fixture's frozen manifest; the S2 proof records its revision and manifest digest alongside the tested source head and package digest.
The S2 and S5 drivers report whether Artium was selected, with an explicit skip reason when absent; a standalone pass does not establish hosted admission.
Hosted CLI behavior scenarios must execute and match the expected exit code and standalone result; expected admission refusals are checked separately for their exact error code and recorded in `hostedRefusals`.
The fixture must admit item positionals, raw GET paths and the declared read flags while continuing to block credential and endpoint overrides.
The S3 and S4 drivers use the same fixture selectors for opt-in hosted write journeys through the real local client, server, credential writer and runner.
They report an explicit skip reason when the fixture is absent.
The S4.2 and S4.3 journeys additionally require admission for managed uploads, protected inputs and dedicated authenticated artifact transfers.
Ordinary hosted download calls and arbitrary host file paths remain refused.
Route classification covers all captured methods; this does not claim completion of every business workflow.
