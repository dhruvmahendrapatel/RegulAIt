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
one fixable HIGH advisory is allow-listed with an expiry (fsspec CVE-2026-104851: garak 0.17.0's `datasets<4.0` holds
fsspec at 2025.3.0; reached only on the image's own read-only, hash-pinned Hub cache; ADR-0187 decisions 160 and 201;
`security/image-allowlist.engine-garak.json`). The 20 licence entries outside the ADR-0176 list were **accepted by the
owner on 2026-10-10** (open question 21; decision 193), MPL-2.0 only while unmodified, which the gate checks (decision
194). The owner's acceptance makes the image admissible once CI's scans of the OS layer and the native libraries are
clean. The shipped manifest carries no digest, so the engine cannot be enabled (ADR-0187 decision 3).

The licence gate was run on the exact installed closure (the pinned cp312 wheels in a Python 3.12 venv, pruned and
with pip removed as the Dockerfile does, 2026-10-10): **197 allowed, 23 admitted by the allow file (all accepted by the
owner: 3 by decision 106, 20 by decision 193), 0 denied.** The gate prints the whole per-distribution inventory in the
build log.

**Open advisories on the pinned closure (OSV, 2026-10-10). None can be fixed without breaking garak's own pins:**
- fsspec 2025.3.0, GHSA-27vj-qcqg-25rc (high, fixed in 2026.6.0): allow-listed with an expiry, as described above.
- datasets 3.6.0, GHSA-379c-qx7v-6h59 (moderate, path traversal through `file_name` metadata in folder-based
  builders, fixed only in 5.0.1). garak 0.17.0, its latest release, requires `datasets<4.0`, and the last 3.x release
  is 3.6.0, so the fix is a major upgrade that garak forbids. Moderate is below the image gate (HIGH and CRITICAL), and
  datasets is reached only on the same read-only, pre-seeded cache path as fsspec. Take 5.x when a garak release
  allows it: datasets 5.0.1 also lifts the fsspec cap to `<=2026.6.0`, which clears the fsspec advisory too.
- nltk 3.10.3, GHSA-8mgp-746c-j5xp (high, model-artifact APIs bypass the path checks): no patched release exists
  (3.10.3 is both the latest release and the last affected one), so the image gate does not count it. garak requires
  `nltk>=3.10.3`, so a fixed release can be taken by bumping the pin and its hash here, with no change to garak.
Re-check all three at each garak or nltk release.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `garak` (PyPI, github.com/NVIDIA/garak) | `0.17.0` (released 2026-09-09; wheel sha256 `9a67e629…db145`, the hash R10 checked independently) | Apache-2.0 (`LICENSE`, SPDX headers; its METADATA names no licence) | The engine (ADR-0187 B5-G). Only the probes in the shared catalogue run (`packages/shared/src/engines/garak.ts`); 23 data paths whose licence or provenance is excluded are DELETED from the image (`excluded-data.txt`, decisions 145 and 197). Its probe metadata (`plugin_cache.json`, sha256 `25484e24…134a52`) is what the catalogue's detector and OWASP columns are generated from; the build refuses another. |
| bundled garak data that STAYS (admitted by G19) | as in the wheel | MIT: in-the-wild jailbreak prompts, AutoDAN cached prompts, Snowballed Hallucination, HarmBench (shipped with its LICENSE), adaptive attacks, DRA, GCG cached suffixes; Apache-2.0: Do-Not-Answer, RealToxicityPrompts subset; garak-authored (the package's Apache-2.0): payloads, XSS templates, latent-injection, encoding and smuggling payloads, tags, the system-prompt attack templates | The admitted probes' payloads (R10 §garak bundled data). RealToxicityPrompts' probes are still not run: their detector's model is not pre-seeded (decision 196). |
| bundled garak data that STAYS since the owner's decision of 2026-10-10 (open question 20; decision 197) | as in the wheel | **Unicode License v3** (`badchars/intentional.txt`, Unicode Security Mechanisms data, "© 2025 Unicode®, Inc."); **CC-BY-4.0** (`ldnoobw-en.txt`, the "List of Dirty, Naughty, Obscene, and Otherwise Bad Words", LDNOOBW project contributors); the inline payloads garak reproduces from named third-party posts (doctor, grandma, goodside, glitch), in garak's Apache-2.0 code | badchars.BadCharacters and the doctor, grandma, goodside and glitch probes. **Attribution:** the Unicode copyright and permission notice and the CC-BY-4.0 credit are reproduced in the image at `/opt/garak/NOTICES.txt` (`IMAGE-NOTICES.txt`), as those licences require. `ldnoobw-en.txt` is read only by a detector no planned probe uses. The two unverified word lists (`profanity_en.csv`, `ofcom-potentially-offensive.txt`) stay DELETED (owner, open question 26). |
| **Hugging Face Hub assets pre-seeded** (owner 2026-10-10, open question 22; decisions 198-200) | each at a pinned commit, every file by sha256 (`hf-preseed.json`) | models: `garak-llm/refutation_detector_distilbert` (Apache-2.0), `garak-llm/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli` (MIT); datasets (all Apache-2.0): `garak-llm/{pypi-20241031, npm-20241031, rubygems-20241031, dart-20250811, perl-20250811, raku-20250811}`, `garak-llm/drh-System-Prompt-processed` | The package-hallucination probes' package lists, the system-prompt probe's prompts, and the two NLI detectors. Each licence was read from the card at the pinned commit (the build re-reads it); the tree ships read-only at `/opt/garak/hf` (about 1.9 GB of files plus about 0.25 GB of materialised datasets) and is proven to load with no network in a `--network=none` build step. Credits in `/opt/garak/NOTICES.txt`. |
| **Admitted by the owner but NOT shipped** (open question 20) | — | `garak-llm/roberta_toxicity_classifier` (CreativeML **Open RAIL++-M**, use-restricted; a pickle-format weights file); `garak-llm/tm-system_prompt` (**CC-BY-4.0**) | Not pre-seeded (open question 22 named only the licence-clear assets), so the toxicity-detector probes are not run and the system-prompt probe is configured with the Apache-2.0 dataset alone. **The OpenRAIL use restrictions (Attachment A) are reproduced in full in the image notices**, and bind any use of that model with this engine; the CC-BY-4.0 credit for the second dataset is recorded there too. |
| `torch` (CPU-only build, from the CPU wheel index by URL) | `2.14.1+cpu` | `Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT` (the LLVM-exception and BSL-1.0 terms **accepted by the owner 2026-10-10**, decision 193; "BSL-1.0" is the Boost Software License, not the Business Source License ADR-0176 bans); the native libraries inside the wheel are **not yet scanned** | A hard dependency of garak (imported by its plugin loader and detector base). The default PyPI resolution pulls 14 proprietary CUDA runtime packages; the CPU wheel pulls none (R10 consequence 1). |
| the rest of the closure (176 distributions) | as pinned in `requirements.txt` / `requirements-sdist.txt` | on the ADR-0176 list by METADATA, or by a licence READ from the wheel's own licence file (`licence-readings.json`, 28 readings, each pinned to its version and the file's sha256), except the entries below | garak's HTTP clients, configuration, dataset and model loaders (never used to fetch: every switch is offline, decision 141), and the optional generator SDKs garak depends on (never called: the only generator is the gateway's OpenAI-compatible route). |
| **Accepted by owner 2026-10-09 (ADR-0187 decision 106), reused** | numpy `2.5.3` | numpy: Zlib; `numpy.libs/libgfortran`: GPL-3.0-or-later WITH GCC-exception-3.1; `numpy.libs/libquadmath`: LGPL-2.1-or-later | The same numpy runtime code the modelscan image ships; decision 106 says garak reuses it. |
| **Accepted by owner 2026-10-10 (ADR-0187 open question 21; decision 193)** | as installed | PSF-2.0: CPython, `aiohappyeyeballs`, `defusedxml`, `typing_extensions`; MPL-2.0 (file-level copyleft, **admitted only while unmodified**): `certifi`, `mikeshardmind-base2048` (a direct garak dependency), `orjson`, `tqdm`; ZPL-2.1: `datetime`, `zope.interface`; MIT-0: `cffi`; CNRI-Python: `regex`; MIT-CMU: `pillow`; pillow's bundled `libfreetype` (FTL), `libharfbuzz` (MIT-Modern-Variant), `libjpeg` (IJG AND BSD-3-Clause AND Zlib), `libpng16` (libpng-2.0), `libtiff` (libtiff); torch's LLVM-exception and BSL-1.0 terms | All permissive or file-level; none is GPL, AGPL, SSPL or BUSL. Each entry in `licence-allow.json` says "accepted by owner 2026-10-10 (ADR-0187 decision 193)" with its reason; the four MPL-2.0 entries carry `"condition": "unmodified"`, and the gate admits them only when every file of the distribution matches its wheel RECORD hash (decision 194). The acceptance amends ADR-0176's list for these named licences in shipped engine images only. |
| How the gate treats them | — | — | `licence-gate.mjs` is the modelscan gate (decision 106) plus pinned readings and pillow's native-library table (decision 157) and conditions (decision 194). It denies anything outside the list that `licence-allow.json` does not name (a licence not named stays DENIED, even for a subject that has another admitted term), refuses an allow entry whose decision is neither "pending owner decision" nor a dated owner acceptance naming its ADR decision, refuses an MPL-2.0 entry without the `unmodified` condition, denies a conditional row whose condition fails, refuses a malformed reading, and fails on an allow entry or a reading that matches nothing installed (stale). |
| Python base image `python:3.12-slim-trixie` | digest `sha256:a6e34c59…dc11b1` (the modelscan image's) | CPython: PSF-2.0 (pending, above); Debian packages: various (the OS layer carries GPL-licensed system packages such as the shell and coreutils, as the gateway image does) | The runtime of both containers. pip is removed from it and from the venv. |
| Node.js binary, from the gateway image's base `node:22-trixie-slim` | the gateway image's digest (`sha256:154ba2f4…a98dfa`) | MIT (with its bundled dependencies' notices) | Runs the runner and worker shim. Only the `node` binary is copied in; no npm, npx or corepack. |
| `zod` (npm, a direct dependency of the shim) | `3.25.76` (the version `@regulait/shared` already locks) | MIT | Validates the exchange's job and done files and the worker's self-test. |
| `write-file-atomic` 8.0.0 and `signal-exit` 4.1.0 (npm, through `@regulait/engine-runner`) | as locked | ISC | The runner token and retained results are written durably; see `packages/engine-runner/THIRD_PARTY.md`. |

Not shipped: no Hugging Face asset beyond the nine pre-seeded above (the probes that need another are declared
not run), no CyberSecEval file (open question 23), and no upstream image.

Open-source check (ADR-0176) for what B5-G wrote itself: garak is used, not rewritten — its own report format
(`report.jsonl`) is the only result source, its own probe metadata generates the catalogue's columns, and its own
OpenAI-compatible generator reaches the gateway. Our code is the governance part: which probes may run (licence and
provenance), the mapper's not-clean rules, the runner/worker split and the worker's self-test. No library parses
garak's report for us (it is JSON Lines; `JSON.parse` per line with our consistency checks). `pip-licenses` (MIT) was
not taken for the gate for the reason recorded for modelscan (it does not see bundled native libraries).
