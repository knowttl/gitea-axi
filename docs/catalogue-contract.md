# Catalogue and discovery

`gitea-axi capabilities` accounts for the gh-axi 0.1.46 baseline: 124 leaves, 397 command-specific flag entries, four global selectors and 46 selected PR fields.
`gitea-axi capabilities C038` retains a leaf's source expected outcome and reports every captured flag, including unsupported ones.
`schemas/catalogue.json` is a normalized baseline data contract, independent of implementation status.
The executable registry owns available flags, compatibility-gap refusals, help and hosted effect metadata.
An accepted flag means an owned interface is available; it does not establish complete baseline semantics or full parity.
No command is counted as full baseline parity.

| Investigation | Retained conclusion |
|---|---|
| Discussions, gists, all 16 project leaves | Neither the served 1.23.4 specification nor the retained official 1.24.0 template identifies the required discussion/gist/Projects v2 API. Comments, repositories and project UI settings are not substitutes. |
| Issue locks | 1.23.4 lacks a lock endpoint. The 1.24.0 issue lock route is a candidate only; no upgrade or live commissioning is claimed. |
| Issue transfer/subissues | No evidenced transfer or parent/child API in either retained contract. Repository transfer, blocks and dependencies are different operations. |
| Draft transitions | Neither retained EditPullRequestOption exposes a draft transition field. `pr ready` refuses; reading the draft field does not implement changing it. |
| Review posting (C043/CX-007) | CreatePullReviewOptions supplies event and commit fields without establishing event values or atomic stale-head refusal. Posting remains unavailable; a preflight read cannot close the race. |
| HEAD | No documented HEAD route/effect contract. Refuse without substituting GET. |
| jq/template | Deliberately unimplemented until an evaluator, grammar and compatibility contract are selected. Both options refuse before requests or writes. |
| Newer Actions APIs | The retained 1.24.0 routes remain investigation candidates. Task summaries do not establish full run/job/artifact behavior. |
| Numeric IDs | `fullDatabaseId` is the vendor numeric ID. The GraphQL node `id` selector remains a gap. |
| Status rollups | Results explicitly report `source: commit-statuses` and `partial: true`. Passed/failed/pending counts do not claim full check suites. |

See the [README](../README.md) for repository selectors, profile selection and hosted credential restrictions, including the current root-level `-R` and search `--hostname` limitations.

## Pending hooks and updater contracts

Scope amendment: firstmate decision `gitea-s6-3-semantics`.
S6.4 hook install/repair (C096) and update installation/rollback (C122/C123) are deferred because no retained evidence defines agent targets, escaping or an update channel; they ship as explicit refusals and remain pending acceptance items.
Public follow-up: https://github.com/knowttl/gitea-axi/issues/38

C096's retained setup help establishes agent SessionStart hooks but no supported agent path, configuration schema or repair contract.
C121's root help establishes the dashboard but not its exact sections and limits.
C122/C123 establish upgrade and check-only purposes but not distribution ownership, integrity, rollback or exact check semantics.
`setup hooks`, `update` and `update --check` therefore return explicit compatibility gaps before credential resolution, configuration writes, package installation or network access.
The existing bounded repository dashboard is an owned interface; baseline dashboard parity remains pending.
Hook installation/idempotent repair and updater installation/integrity/rollback/check-only distribution journeys remain pending.
No agent paths, update channel, repository webhooks or telemetry are introduced.

## Generation and verification

`npm run generate` compiles the current registry and regenerates help, the skill, the capabilities summary and host inventory.
The executable registry in `src/registry.ts` owns their command metadata; the retained Swagger owns the generated response schemas, route types and classified raw-route registry produced by the same command.
`npm run generate:check` compiles the current source and refuses stale generated artifacts.
The S6.4 check demonstrates refusal after adding a command to a disposable registry copy.
The generated skill uses noninteractive npm package invocations and contains no live session state.

Run `node scripts/verify.mjs --task S6.3` and `node scripts/verify.mjs --task S6.4` under the process-level outbound network deny.
These checks install an immutable tarball offline, exercise the actual bin, enumerate the retained command/flag outcomes and exercise safe gap refusals.
S6.3 reuses the existing S2.3 installed journeys to verify all 46 field selections.
Artium journeys are opt-in via GITEA_AXI_ARTIUM_ROOT and GITEA_AXI_ARTIUM_MANIFEST; their absence is reported as an explicit skip.
Native Windows and live commissioning remain pending.

Provenance: retained capabilities.json SHA-256 `7ade3f01dffc20eab4175963f98e1bbc4436bdde43536f20606ebf755450a36c`; served 1.23.4 Swagger SHA-256 `ef9cfca11ee68a562e07b3d20dc88df0ed43e812794e20b3dc1f4ee3d67ae88d`; official 1.24.0 template SHA-256 `569c1c05537eeb1fbcd040146f5e99268692c8826b28b517dc2208b721e39707`.
These are retained schema observations and baseline captures, not new live observations.
