# ADR-0189 B0 BOM spike

Throwaway research code for ADR-0189 slice B0. No workspace package imports it, and `pnpm-workspace.yaml` includes
only `apps/*` and `packages/*`. It writes no product code, migration, route or CI job. The findings and the GO/NO-GO
decisions are in [R12](../../docs/research/R12-bom-b0-spike.md).

Run from the repository root. Node 22 or later runs the suite, because the suite imports the product `canonicalJson`
from `packages/shared/src/audit-chain.ts` through Node's type stripping. The fresh-process check also uses
`/opt/node20` and `/opt/node21` when they exist, and needs at least two Node majors.

```sh
npm ci --prefix spikes/bom-b0 --ignore-scripts
npm --prefix spikes/bom-b0 run test:offline   # the whole suite inside `unshare -n` (no network namespace)
npm --prefix spikes/bom-b0 run licences       # fails on licence-inventory or notice drift
node spikes/bom-b0/model-check.mjs            # item 1 on its own (evidence/model-check.json)
```

The SPDX SHACL check (CI-only tooling, never shipped) runs with a hash-locked Python closure and no network:

```sh
VENV=<a scratch directory>/spdxv   # executed with a session scratch directory
python3 -m venv "$VENV"
"$VENV/bin/pip" install --no-deps --require-hashes -r spikes/bom-b0/spdx3/requirements.lock
cd spikes/bom-b0 && unshare -n "$VENV/bin/python" -I spdx3/run_offline.py \
  evidence/sample.spdx-3.0.1.json spdx3/neg-supplied-by-tool.expect-fail.json
```

| File | Purpose |
|---|---|
| `model-check.mjs` | Item 1. Checks at runtime which ML-BOM fields the library's model and serializer represent. |
| `validators.mjs` | Item 2. Uses the pinned Ajv to compile the CycloneDX 1.7 and 1.6 schemas bundled in the library and the vendored SPDX 3.0.1 schema, from local files only. `idn-email` rejects every value. |
| `render.mjs` | Item 4. A pure renderer from records to the native body and the CycloneDX 1.7, CycloneDX 1.6 and SPDX 3.0.1 renderings. Every output is RFC 8785 canonical, and the native body is signed with a synthetic, fixed-seed Ed25519 key. |
| `render-cli.mjs` | Renders in a fresh process and prints the hashes and the signature. |
| `fixtures/records-a.json`, `records-b.json` | The same facts, in two replicas' row and key orders. `make-records-b.mjs` generates B from A. |
| `spike.test.mjs` | Items 1 to 4, with negative controls and non-vacuity probes. Item 3 covers the BOM-shaped `canonicalize` corpus. |
| `spdx3/` | The offline driver for `spdx3-validate` 0.0.7, its hash-locked closure, and a negative control that passes the JSON schema but fails SHACL. |
| `schemas/` | The vendored SPDX 3.0.1 JSON schema, model and context. Their sources and sha256 are in `THIRD_PARTY.md`. |
| `evidence/` | The test output, the model-check output, the sample renderings and their hashes, and the offline SHACL output. |

All records are synthetic. The signing key is derived from a fixed public seed, so it proves determinism only and is
never a product key.
