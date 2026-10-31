# Retained S1.1 evidence

These files retain their exact pack bytes and relative pack paths under `evidence/`.
Source: `api-evidence/` pack at commit `fa6b64636a465d639487411bdd79ed5d738c799d`.
The four API captures below were verified against that pack's `manifest.json`.
Fixtures preserve the pack's sanitized observation provenance; replaying them offline does not establish live behaviour.

| Repository file | Pack path | SHA-256 | Hash authority |
|---|---|---|---|
| `evidence/docs/gitea-1.23.4-swagger.json` | `docs/gitea-1.23.4-swagger.json` | `ef9cfca11ee68a562e07b3d20dc88df0ed43e812794e20b3dc1f4ee3d67ae88d` | manifest.json |
| `evidence/fixtures/P-001.json` | `fixtures/P-001.json` | `6dc7ae83ee68c57622fc8bc18913c2572b064705aca5d2f7e1abcefda5642fe3` | manifest.json |
| `evidence/fixtures/P-002.json` | `fixtures/P-002.json` | `21cf944654a5d9cbf2ffa96b7eca898b4a3ce01c222bc7f7fcdeac84e0368ca7` | manifest.json |
| `evidence/fixtures/P-004.json` | `fixtures/P-004.json` | `b5c434083a5d5b0e00f911d243b5ef46771b10db5eb5fa3e093dbb95c6edf7b3` | manifest.json |
| `evidence/reference/host/package.json` | `reference/host/package.json` | `3f290d3c3a3da67d4baee25f114e9c86db3c0d7d9faea45bb1c5efcfd686578a` | not listed in manifest.json - capture hash recorded at copy time |

The source commit above also supplies the host package capture's provenance.
`foundation.md` was read as setup guidance and is not retained as public implementation evidence.
`node scripts/verify.mjs --task S1.1` checks all retained hashes before building.
