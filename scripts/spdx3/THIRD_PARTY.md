# Third-party components — `scripts/spdx3` (CI only, never shipped)

ADR-0189 slice B5: the offline SHACL conformance check of the product's SPDX 3.0.1 renderings (`run_offline.py`), run
in CI inside a network namespace. Nothing here is in an image, a package or a bundle (`.dockerignore` and the build
never include `scripts/spdx3`). Ported from spike B0 (`spikes/bom-b0`, R12 §5).

## Vendored SPDX 3.0.1 files (specification data, not code)

Fetched 2026-10-10 from spdx.org (spike B0). Community-Spec-1.0 / CC-BY-3.0, admitted as standards-body specification
data by the ADR-0176 amendment of 2026-10-10 (ADR-0189 amendment 7). `run_offline.py` refuses to run when a file's
sha256 differs from the pin below.

| File | Source | sha256 |
|---|---|---|
| `spdx-model.ttl` | https://spdx.org/rdf/3.0.1/spdx-model.ttl | `30ebb4af2d70a9809044ef46f44cc3dc5125226d70f818a50ed2e1d5f404c593` |
| `spdx-context.jsonld` | https://spdx.org/rdf/3.0.1/spdx-context.jsonld | `c72b0928f094c83e5c127784edb1ebca2af74a104fcacc007c332b23cbc788bd` |
| `../../packages/shared/vendor/spdx-3.0.1/spdx-json-schema.json` (shared with the product; listed in `packages/shared/THIRD_PARTY.md`) | https://spdx.org/schema/3.0.1/spdx-json-schema.json | `582c64e809d5b3ef9bd0c4de13a32391b47b0284a3e8d199569fb96f649234b1` |

## Python closure (`requirements.lock`, hash-locked)

`spdx3-validate` 0.0.7 (MIT, released 2026-08-10) and its 22 dependencies, every wheel hash pinned, installed with
`pip install --no-deps --require-hashes` (halo 0.0.31 publishes only a py2 wheel, so its hash-pinned sdist is built). Licences per package metadata: MIT (13), BSD-3-Clause/BSD
(3: rdflib, prettytable, colorama), Apache-2.0 (2: pyshacl, importlib_metadata), Apache-2.0 OR BSD-2-Clause
(packaging), PSF-2.0 (typing_extensions), W3C-20150513 (owlrl). PSF-2.0 and W3C-20150513 are admitted for CI-only
tooling by the ADR-0176 amendment of 2026-10-10 (ADR-0189 amendment 6). Each package's licence is also named on its
line in `requirements.lock`. The stock `spdx3-validate` CLI is never run: it downloads the schema, model and context
at run time (amendment 4).
