# Third-party components — the garak engine image (`engines/garak`)

Open-source components the garak image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). The Python closure (178 distributions) is pinned by
`engines/garak/requirements.txt` (every wheel by version and sha256; torch is the CPU-only wheel by direct URL) and
`requirements-sdist.txt` (two hashed sdists), installed with `pip install --require-hashes --no-deps`; the runner and
worker shim (`packages/engine-garak`) is pinned by `pnpm-lock.yaml`. Facts were read from the pinned wheels on
2026-10-10 (docs/research/R10-engine-admission.md §garak, and ADR-0187 decisions 140 onward).

**Admission status: NOT ADMISSIBLE YET.** The image has not been built where its digest could be recorded (no Docker
daemon where B5-G was built; `security.yml` builds, scans and signs every `engines/*/Dockerfile`, decision 120), the
image-level scan (OS layer, vulnerabilities, licences, and the native libraries inside the torch wheel) has not run,
the closure's advisories have not been checked (pip-audit or OSV at the first build), and 20 licence entries outside
the ADR-0176 list await an owner decision (below). The shipped manifest carries no digest, so the engine cannot be
enabled (ADR-0187 decision 3).

The licence gate was run on the exact installed closure (the pinned cp312 wheels in a Python 3.12 venv, 2026-10-10):
**198 allowed, 23 admitted by the allow file (3 accepted by the owner, 20 pending), 0 denied.** The gate prints the
whole per-distribution inventory in the build log.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `garak` (PyPI, github.com/NVIDIA/garak) | `0.17.0` (released 2026-09-09; wheel sha256 `9a67e629…db145`, the hash R10 checked independently) | Apache-2.0 (`LICENSE`, SPDX headers; its METADATA names no licence) | The engine (ADR-0187 B5-G). Only the probes in the shared catalogue run (`packages/shared/src/engines/garak.ts`); 25 data paths whose licence or provenance is excluded are DELETED from the image (`excluded-data.txt`, decision 145). Its probe metadata (`plugin_cache.json`, sha256 `25484e24…134a52`) is what the catalogue's detector and OWASP columns are generated from; the build refuses another. |
| bundled garak data that STAYS (admitted by G19) | as in the wheel | MIT: in-the-wild jailbreak prompts, AutoDAN cached prompts, Snowballed Hallucination, HarmBench (shipped with its LICENSE), adaptive attacks, DRA, GCG cached suffixes; Apache-2.0: Do-Not-Answer, RealToxicityPrompts subset; garak-authored (the package's Apache-2.0): payloads, XSS templates, latent-injection, encoding and smuggling payloads, tags | The admitted probes' payloads (R10 §garak bundled data). RealToxicityPrompts' probes are still not run (their detector's licence is an owner decision). |
| `torch` (CPU-only build, from the CPU wheel index by URL) | `2.14.1+cpu` | `Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT` (the LLVM-exception and BSL-1.0 terms **pending**); the native libraries inside the wheel are **not yet scanned** | A hard dependency of garak (imported by its plugin loader and detector base). The default PyPI resolution pulls 14 proprietary CUDA runtime packages; the CPU wheel pulls none (R10 consequence 1). |
| the rest of the closure (176 distributions) | as pinned in `requirements.txt` / `requirements-sdist.txt` | on the ADR-0176 list by METADATA, or by a licence READ from the wheel's own licence file (`licence-readings.json`, 28 readings, each pinned to its version and the file's sha256), except the entries below | garak's HTTP clients, configuration, dataset and model loaders (never used to fetch: every switch is offline, decision 141), and the optional generator SDKs garak depends on (never called: the only generator is the gateway's OpenAI-compatible route). |
| **Accepted by owner 2026-10-09 (ADR-0187 decision 106), reused** | numpy `2.5.3` | numpy: Zlib; `numpy.libs/libgfortran`: GPL-3.0-or-later WITH GCC-exception-3.1; `numpy.libs/libquadmath`: LGPL-2.1-or-later | The same numpy runtime code the modelscan image ships; decision 106 says garak reuses it. |
| **Pending an owner decision** (ADR-0187 open question B5-G 3) | as installed | PSF-2.0: CPython, `aiohappyeyeballs`, `defusedxml`, `typing_extensions`; MPL-2.0 (file-level copyleft, unmodified): `certifi`, `mikeshardmind-base2048` (a direct garak dependency), `orjson`, `tqdm`; ZPL-2.1: `datetime`, `zope.interface`; MIT-0: `cffi`; CNRI-Python: `regex`; MIT-CMU: `pillow`; pillow's bundled `libfreetype` (FTL), `libharfbuzz` (MIT-Modern-Variant), `libjpeg` (IJG AND BSD-3-Clause AND Zlib), `libpng16` (libpng-2.0), `libtiff` (libtiff); torch's LLVM-exception and BSL-1.0 terms | All permissive or file-level; none is GPL, AGPL, SSPL or BUSL. Each entry in `licence-allow.json` says exactly "pending owner decision" with its reason. |
| How the gate treats them | — | — | `licence-gate.mjs` is the modelscan gate (decision 106) plus pinned readings and pillow's native-library table (decision 157). It denies anything outside the list that `licence-allow.json` does not name, refuses an allow entry whose decision is neither "pending owner decision" nor a dated owner acceptance naming its ADR decision, refuses a malformed reading, and fails on an allow entry or a reading that matches nothing installed (stale). |
| Python base image `python:3.12-slim-trixie` | digest `sha256:a6e34c59…dc11b1` (the modelscan image's) | CPython: PSF-2.0 (pending, above); Debian packages: various (the OS layer carries GPL-licensed system packages such as the shell and coreutils, as the gateway image does) | The runtime of both containers. pip is removed from it and from the venv. |
| Node.js binary, from the gateway image's base `node:22-trixie-slim` | the gateway image's digest (`sha256:154ba2f4…a98dfa`) | MIT (with its bundled dependencies' notices) | Runs the runner and worker shim. Only the `node` binary is copied in; no npm, npx or corepack. |
| `zod` (npm, a direct dependency of the shim) | `3.25.76` (the version `@regulait/shared` already locks) | MIT | Validates the exchange's job and done files and the worker's self-test. |
| `write-file-atomic` 8.0.0 and `signal-exit` 4.1.0 (npm, through `@regulait/engine-runner`) | as locked | ISC | The runner token and retained results are written durably; see `packages/engine-runner/THIRD_PARTY.md`. |

Not shipped: no Hugging Face model or dataset is pre-seeded (the probes that need one are declared not run;
pre-seeding the licence-clear assets R10 lists is open question B5-G 4), no CyberSecEval file (open question B5-G 5),
and no upstream image.

Open-source check (ADR-0176) for what B5-G wrote itself: garak is used, not rewritten — its own report format
(`report.jsonl`) is the only result source, its own probe metadata generates the catalogue's columns, and its own
OpenAI-compatible generator reaches the gateway. Our code is the governance part: which probes may run (licence and
provenance), the mapper's not-clean rules, the runner/worker split and the worker's self-test. No library parses
garak's report for us (it is JSON Lines; `JSON.parse` per line with our consistency checks). `pip-licenses` (MIT) was
not taken for the gate for the reason recorded for modelscan (it does not see bundled native libraries).
