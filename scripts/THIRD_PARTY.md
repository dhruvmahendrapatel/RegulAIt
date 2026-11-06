# Third-party components — repository dev tools (`scripts/`, CI only, never shipped)

Root `devDependencies` used only by the scripts in this directory. Nothing here is in an image, a package or a bundle
(the images copy `apps/` and `packages/` only). Exact versions are pinned in the root `package.json` and the lockfile.
`scripts/spdx3/` keeps its own list (`scripts/spdx3/THIRD_PARTY.md`).

| Package | Version | Licence | Used by | Why |
|---|---|---|---|---|
| `dependency-cruiser` | 18.6.0 | MIT | `preflight-import-cycles.mjs` (and the module list of `preflight-import-smoke.mjs`) | ADR-0190 I4 follow-ups: finds the static import cycles of the compiled gateway, for the CI ratchet against new ones. It parses (acorn) and resolves (enhanced-resolve); the script only selects, sorts and compares edges. Works offline, no network at run time. Its transitive runtime closure is 42 packages (39 MIT, 3 ISC; checked 2026-10-16), 34 of them new to the lockfile. |
| `js-yaml` | 4.3.2 | MIT | `refresh-framework-imports.mjs` | ADR-0215 (P5): parses the MITRE ATLAS YAML release when a developer refreshes the vendored framework-import snapshots. Safe `JSON_SCHEMA` load only (no custom types). The same version was already in the lockfile through other tools; one dependency (`argparse`, Python-2.0 licence, CLI only and not loaded by `load`). Never runs in the product: the product reads the vendored JSON. |

## Search record (ADR-0176)

YAML parsing for the framework-import refresh, 2026-10-30:

- `js-yaml` 4.3.2 (MIT): chosen. Already in the lockfile at this exact version, maintained, safe schema by default.
- `yaml` (ISC): equally suitable, but new to the lockfile; no reason to add a second YAML parser.
- Not parsing YAML at all: ATLAS publishes its release only as YAML.

Import-cycle detection, 2026-10-16:

- `dependency-cruiser` 18.6.0 (MIT, released 2026-10): chosen. Actively maintained, pins its own dependencies, and
  marks every dependency edge that lies on a cycle (`circular`), which gives a deterministic, order-independent
  baseline. Its own "known violations" baseline was not used: it stores one cycle PATH per violation, and which path
  is reported for an edge depends on the search order, so an unrelated new import could make an old cycle look new.
- `dpdm` 4.3.0 (MIT, released 2026-07): rejected. Its `glob` 13 dependency is BlueOak-1.0.0, which is not on the
  ADR-0176 licence list.
- `madge` 8.0.0 (MIT): rejected. Last release 2024-08, outside the "release in about the last 12 months" bar.
- `skott` 0.35 (MIT): not chosen. It brings a web UI, a file watcher with a native addon and a functional-programming
  runtime, far more than a cycle check needs.

The load-alone smoke check (`preflight-import-smoke.mjs`) uses only Node itself (child processes); no library does
"import each module first in a fresh process", and the script is that loop plus containment.
