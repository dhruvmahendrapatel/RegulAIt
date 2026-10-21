# Third-party components — the garak engine image (`engines/garak`)

Open-source components the garak image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). The Python closure (178 distributions) is pinned by
`engines/garak/requirements.txt` (every wheel by version and sha256; torch is the CPU-only wheel by direct URL) and
`requirements-sdist.txt` (two hashed sdists), installed with `pip install --require-hashes --no-deps`; the runner and
worker shim (`packages/engine-garak`) is pinned by `pnpm-lock.yaml`. Facts were read from the pinned wheels on
2026-10-10 (docs/research/R10-engine-admission.md §garak, and ADR-0187 decisions 140 onward), and re-read for the
garak 0.17.1 upgrade on 2026-10-21 (the section of that date below).

**Admission status: NOT ADMISSIBLE YET.** The image has not been built where its digest could be recorded (no Docker
daemon where B5-G was built; `security.yml` builds, scans and signs every `engines/*/Dockerfile`, decision 120), the
image-level scan (OS layer, vulnerabilities, licences, and the native libraries inside the torch wheel) has not run.
The image allow-list (`security/image-allowlist.engine-garak.json`) is empty since the garak 0.17.1 upgrade
(2026-10-21): the fsspec entry of decisions 160 and 201 was removed with the datasets 5.1.0 and fsspec 2026.7.0
pins. The 20 licence entries outside the ADR-0176 list were **accepted by the
owner on 2026-10-10** (open question 21; decision 193), MPL-2.0 only while unmodified, which the gate checks (decision
194). The owner's acceptance makes the image admissible once CI's scans of the OS layer and the native libraries are
clean. The shipped manifest carries no digest, so the engine cannot be enabled (ADR-0187 decision 3).

The licence gate was run on the exact installed closure (the pinned cp312 wheels in a Python 3.12 venv, pruned and
with pip removed as the Dockerfile does; first 2026-10-10, again for garak 0.17.1 on 2026-10-21): **197 allowed, 23 admitted by the allow file (all accepted by the
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

**Re-checked 2026-10-11 for Dependabot PR #347 (datasets 3.6.0 to 5.0.1, fsspec 2025.3.0 to 2026.6.0), which is
superseded, not merged.** The PR cannot build: garak 0.17.0 declares `datasets>=3.0.0,<4.0`, so `pip check` in the
Dockerfile fails. Evidence for keeping the pins:
- No fix inside garak's range: OSV lists GHSA-379c-qx7v-6h59 (CVE-2026-66007) as fixed only in datasets 5.0.1 and
  GHSA-27vj-qcqg-25rc (CVE-2026-104851) as fixed only in fsspec 2026.6.0, and every datasets 3.x caps fsspec at or
  below 2025.3.0.
- No garak release allows them: 0.17.0 is still the latest on PyPI, and garak's development branch
  (0.17.1.pre1) still declares `datasets>=3.0.0,<4.0`.
- The gate reads the pins as decision 160 does: the pinned Trivy 0.74.0 over this `requirements.txt` reports datasets
  as MEDIUM (severity source ghsa, so not gated), fsspec as HIGH (allow-listed), and nltk as HIGH with no fix (not
  gated). `security-gate.mjs --kind trivy` passes with the current allow-list. An entry for the datasets advisory
  would match no gated finding and fail the gate as stale, so it is recorded here and not in the allow-list.
- The datasets flaw cannot be reached in this image. It needs a folder-based builder (imagefolder, audiofolder and
  the like) that reads attacker-supplied `file_name` metadata, and the leaked file only leaves through `save_to_disk`
  or `push_to_hub`. garak 0.17.0 calls `load_dataset` only in `detectors/packagehallucination`,
  `probes/sysprompt_extraction`, `probes/audio` and `probes/goat`, and never calls `save_to_disk` or `push_to_hub`.
  The only one that could use a folder-based builder is `audio.AudioAchillesHeel`, and it and `goat.GOATAttack` are
  never planned (`excluded_licence`, `packages/shared/src/engines/garak.ts`). The two planned callers read the
  pre-seeded TSV, JSON Lines and JSON files (the csv and json builders), each pinned by sha256, offline and
  read-only.
The Dependabot alerts for these two advisories should be dismissed as "no bump available" with a link to this
section. The fix path is unchanged: pin the first garak release that allows datasets 5.x.

**Re-checked 2026-10-16 for Dependabot alerts #83 (nltk), #84 (datasets) and #85 (fsspec). None can be patched
today; the pins stay, and the acceptance below runs until 2026-11-16** (ADR-0187 decision 225). Dependabot PRs #239 and
#347 were the same grouped bump (datasets 5.0.1 with fsspec 2026.6.0, covering both #84 and #85); both were closed
unmerged (2026-10-10 and 2026-10-11) because garak's `datasets<4.0` fails `pip check`. The fsspec image allow-list entry
(`security/image-allowlist.engine-garak.json`) expires later, on 2026-12-09; the earlier date, 2026-11-16, governs the
re-check. Read from PyPI's JSON API, OSV and garak's repository on 2026-10-16:
- garak 0.17.0 (2026-09-09) is still the latest release and still declares `datasets>=3.0.0,<4.0` and `nltk>=3.10.3`.
  **New since 2026-10-11:** garak's development branch (`0.17.1.pre1`) now declares `datasets>=5.0.1,<6.0` (with
  `transformers>=5.14.1,<5.20.0`, which our 5.19.0 meets). The first garak release that carries it clears #84 and #85:
  re-resolve the closure with `uv pip compile` as the header of `requirements.txt` says (datasets 5.1.0 caps fsspec at
  `<=2026.7.0`, past the 2026.6.0 fix), re-hash, and drop the fsspec image allow-list entry. An unreleased commit is not
  pinned.
- fsspec GHSA-27vj-qcqg-25rc (CVE-2026-104851, high): fixed in 2026.6.0; every datasets 3.x caps fsspec at or below
  2025.3.0. Allow-listed in the image gate until 2026-12-09 (decision 160), unchanged.
- datasets GHSA-379c-qx7v-6h59 (CVE-2026-66007, moderate): fixed only in 5.0.1 (latest 5.1.0); garak forbids 4.x and up.
  Unreachable as described above.
- nltk GHSA-8mgp-746c-j5xp (CVE-2026-81726, high): still no patched release (OSV `last_affected` 3.10.3, the latest on
  PyPI; nltk's development branch is also 3.10.3). The flaw is in `TransitionParser.train/parse`,
  `AveragedPerceptron.save/load`, `PerceptronTagger.save_to_json` and `save_maxent_params`, which open a caller-chosen
  model path without nltk's `pathsec` checks; it matters only to code that enables `pathsec` and lets untrusted input
  choose that path. garak 0.17.0 (the pinned wheel, sha256 `9a67e629…db145`, grepped) calls none of them: it uses
  `pos_tag` (in `sata`, loading nltk's own tagger from the data directory), `word_tokenize`, the `words`, `stopwords` and
  `wordnet` corpora, `jaro_winkler_similarity`, and `nltk.download`; no path comes from a run. When a fixed nltk is
  released, bump its pin and hash here (garak's `nltk>=3.10.3` allows it).

**Bumped 2026-10-21 for new advisories the image scan reported on unchanged code: certifi 2026.7.22 to 2026.10.19
(GHSA-6q48-6c7w-9gw2, critical) and pillow 12.3.0 to 13.0.0, the lowest fixed release (CVE-2026-112403, critical;
CVE-2026-112397, -112400, -112404, -112895, -112896 and -112897, high).** Only these two pins changed; the closure was not
re-resolved, and datasets and fsspec stay as above. Each sha256 is the cp312 manylinux x86_64 wheel (certifi: the
py3-none-any wheel) from PyPI's JSON API, and the downloaded wheels hash to it. Read from the pinned closure's PyPI
metadata: garak 0.17.0 declares `pillow>=12.3.0`; transformers 5.19.0 `Pillow<=15.0,>=10.0.1` and datasets 3.6.0
`Pillow>=9.4.0` (extras only); requests 2.34.2 `certifi>=2023.5.7`, httpx and httpcore `certifi` unbounded. No pin
excludes either release. pillow 13.0.0 requires Python >=3.11 and adds no dependency outside its extras. The licence
readings stay as they were: pillow's METADATA is still `License-Expression: MIT-CMU`, its wheel bundles the same 18
`pillow.libs` libraries with the same LICENSE sections, and certifi's METADATA is still `License: MPL-2.0` with the
same file list (admitted only while unmodified, decision 194).

**Upgraded 2026-10-21 to garak 0.17.1 (released 2026-10-16), which declares `datasets>=5.0.1,<6.0`. This clears
Dependabot alerts #84 (datasets) and #85 (fsspec) and removes the fsspec image allow-list entry (ADR-0187 decisions
160 and 225).** The closure was re-resolved with `uv pip compile` as the header of `requirements.txt` says, and every
pin's wheel was chosen from PyPI's JSON API (each downloaded wheel hashes to the pinned sha256). Read from PyPI, OSV
and the two garak wheels on 2026-10-21:
- **Fixed:** datasets 3.6.0 to 5.1.0 (GHSA-379c-qx7v-6h59, fixed in 5.0.1) and fsspec 2025.3.0 to 2026.7.0
  (GHSA-27vj-qcqg-25rc, fixed in 2026.6.0; datasets 5.1.0 allows `fsspec<=2026.7.0`). OSV over the new closure reports
  only nltk 3.10.3 GHSA-8mgp-746c-j5xp, which still has no patched release (unchanged, as described above).
- **huggingface-hub drops to 1.33.0 (owner decision 2026-10-21).** litellm 1.106.1, the newest release and the one
  the resolver takes (garak needs `litellm>=1.84.0`, and the gateway route never calls it), newly declares
  `huggingface-hub<2.0` and `filelock<4.0`. The owner chose to take it and let the hub client follow, rather than hold
  it at 2.2.0 with an input floor (which held litellm at 1.103.6). So the hub client goes from 2.2.0 to 1.33.0 and
  filelock from 4.1.0 to 3.32.7. Both are Apache-2.0 and MIT as before. The two clients' cache code is identical
  (`file_download.py` differs only in using httpx instead of httpx2, and `utils/_shared_blobs.py` is byte-identical),
  so the Hub cache layout, including the shared `hub/blobs/<xx>/<xet hash>` store, is unchanged. OSV is clean apart
  from nltk.
- **Changed pins (42):** aiohttp 3.14.5, boto3 and botocore 1.43.116, datasets 5.1.0, dill 0.4.1, filelock 3.32.7,
  fsspec 2026.7.0, garak 0.17.1, google-auth 2.62.0, httpcore2 and httpx2 2.16.0 (released 2026-10-21),
  huggingface-hub 1.33.0, jsonpatch 1.36, jsonpath-ng 1.12.0,
  jsonpointer 3.4, langchain 1.4.6, langchain-core 1.6.12, langchain-protocol 0.0.20, langgraph 1.2.16,
  langgraph-checkpoint 4.3.0, langgraph-prebuilt 1.1.1, langgraph-sdk 0.4.8, langsmith 0.14.11, litellm 1.106.1,
  markdown 3.11.2, multidict 7.1.0, multiprocess 0.70.19, numpy 2.5.4, ormsgpack 1.13.0, pip 26.2.2 (removed from the
  image), pluggy 1.7.0, py-markdown-table 2.0.0, pydantic 2.14.1, pydantic-core 2.50.1, pydantic-settings 2.16.1,
  s3transfer 0.19.3, setuptools 84.2.1, truststore 0.10.5, uuid-utils 0.18.0, wcwidth 0.9.3, xxhash 4.0.2,
  zope-interface 8.7. No package joined or left the closure (178 distributions), certifi 2026.10.19 and pillow
  13.0.0 are kept, and torch stays 2.14.1+cpu (the newest CPU wheel).
- **Licences:** every changed package declares the same licence as before. Three now carry an SPDX
  `License-Expression` (fsspec BSD-3-Clause, jsonpatch BSD-3-Clause, multidict Apache-2.0), so their readings in
  `licence-readings.json` were removed (a reading that matches nothing fails the gate as stale). jsonpointer 3.4
  still says only "Modified BSD License" and ships the same three-clause BSD file (sha256 `d8b24f15…07e5`), so its
  reading moved from 3.2.0 to 3.4 (25 readings). numpy 2.5.4 bundles the same libgfortran and libquadmath, admitted
  under decision 106. The gate on the installed, pruned closure with pip removed reads **197 allowed, 23 admitted,
  0 denied**, and `pip check` is clean.
- **garak's data:** 0.17.1 adds, removes and renames no file under `garak/data`. Only four `dan/*.json` files changed,
  and those are deleted from the image. `excluded-data.txt` is unchanged, and the prune still removes its 23 paths.
  The data the image keeps (badchars, `ldnoobw-en.txt` and the rest) is byte-identical, so the notices are unchanged
  apart from the version. The wheel's `LICENSE` is unchanged. The wheel also ships two stray `.orig` files
  (`detectors/apikey.py.orig`, `probes/base.py.orig`), which nothing imports.
- **Pre-seed:** with datasets 5.1.0 and hub 1.33.0, `preseed-hf.py fetch`, `materialise` and an offline `verify`
  passed on all nine assets, the NLI model included. The verify ran in a fresh network namespace with only loopback
  up, the tree read-only and every offline switch set. The cache layout is unchanged, so `preseed-hf.py` and
  `prune-data.py` needed no change. (It was first proven the same way on hub 2.2.0.)

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `garak` (PyPI, github.com/NVIDIA/garak) | `0.17.1` (released 2026-10-16; wheel sha256 `cef78a79…cfda8`, from PyPI's JSON API and the downloaded wheel; 0.17.0's `9a67e629…db145` was the hash R10 checked independently) | Apache-2.0 (`LICENSE`, SPDX headers; its METADATA names no licence) | The engine (ADR-0187 B5-G). Only the probes in the shared catalogue run (`packages/shared/src/engines/garak.ts`); 23 data paths whose licence or provenance is excluded are DELETED from the image (`excluded-data.txt`, decisions 145 and 197). Its probe metadata (`plugin_cache.json`, sha256 `6ba9cca2…230209`) is what the catalogue's detector and OWASP columns are generated from; the build refuses another. |
| bundled garak data that STAYS (admitted by G19) | as in the wheel | MIT: in-the-wild jailbreak prompts, AutoDAN cached prompts, Snowballed Hallucination, HarmBench (shipped with its LICENSE), adaptive attacks, DRA, GCG cached suffixes; Apache-2.0: Do-Not-Answer, RealToxicityPrompts subset; garak-authored (the package's Apache-2.0): payloads, XSS templates, latent-injection, encoding and smuggling payloads, tags, the system-prompt attack templates | The admitted probes' payloads (R10 §garak bundled data). RealToxicityPrompts' probes are still not run: their detector's model is not pre-seeded (decision 196). |
| bundled garak data that STAYS since the owner's decision of 2026-10-10 (open question 20; decision 197) | as in the wheel | **Unicode License v3** (`badchars/intentional.txt`, Unicode Security Mechanisms data, "© 2025 Unicode®, Inc."); **CC-BY-4.0** (`ldnoobw-en.txt`, the "List of Dirty, Naughty, Obscene, and Otherwise Bad Words", LDNOOBW project contributors); the inline payloads garak reproduces from named third-party posts (doctor, grandma, goodside, glitch), in garak's Apache-2.0 code | badchars.BadCharacters and the doctor, grandma, goodside and glitch probes. **Attribution:** the Unicode copyright and permission notice and the CC-BY-4.0 credit are reproduced in the image at `/opt/garak/NOTICES.txt` (`IMAGE-NOTICES.txt`), as those licences require. `ldnoobw-en.txt` is read only by a detector no planned probe uses. The two unverified word lists (`profanity_en.csv`, `ofcom-potentially-offensive.txt`) stay DELETED (owner, open question 26). |
| **Hugging Face Hub assets pre-seeded** (owner 2026-10-10, open question 22; decisions 198-200) | each at a pinned commit, every file by sha256 (`hf-preseed.json`) | models: `garak-llm/refutation_detector_distilbert` (Apache-2.0), `garak-llm/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli` (MIT); datasets (all Apache-2.0): `garak-llm/{pypi-20241031, npm-20241031, rubygems-20241031, dart-20250811, perl-20250811, raku-20250811}`, `garak-llm/drh-System-Prompt-processed` | The package-hallucination probes' package lists, the system-prompt probe's prompts, and the two NLI detectors. Each licence was read from the card at the pinned commit (the build re-reads it); the tree ships read-only at `/opt/garak/hf` (about 1.9 GB of files plus about 0.25 GB of materialised datasets) and is proven to load with no network in a `--network=none` build step. Credits in `/opt/garak/NOTICES.txt`. |
| **Admitted by the owner but NOT shipped** (open question 20) | — | `garak-llm/roberta_toxicity_classifier` (CreativeML **Open RAIL++-M**, use-restricted; a pickle-format weights file); `garak-llm/tm-system_prompt` (**CC-BY-4.0**) | Not pre-seeded (open question 22 named only the licence-clear assets), so the toxicity-detector probes are not run and the system-prompt probe is configured with the Apache-2.0 dataset alone. **The OpenRAIL use restrictions (Attachment A) are reproduced in full in the image notices**, and bind any use of that model with this engine; the CC-BY-4.0 credit for the second dataset is recorded there too. |
| `torch` (CPU-only build, from the CPU wheel index by URL) | `2.14.1+cpu` | `Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT` (the LLVM-exception and BSL-1.0 terms **accepted by the owner 2026-10-10**, decision 193; "BSL-1.0" is the Boost Software License, not the Business Source License ADR-0176 bans); the native libraries inside the wheel are **not yet scanned** | A hard dependency of garak (imported by its plugin loader and detector base). The default PyPI resolution pulls 14 proprietary CUDA runtime packages; the CPU wheel pulls none (R10 consequence 1). |
| the rest of the closure (176 distributions) | as pinned in `requirements.txt` / `requirements-sdist.txt` | on the ADR-0176 list by METADATA, or by a licence READ from the wheel's own licence file (`licence-readings.json`, 28 readings, each pinned to its version and the file's sha256), except the entries below | garak's HTTP clients, configuration, dataset and model loaders (never used to fetch: every switch is offline, decision 141), and the optional generator SDKs garak depends on (never called: the only generator is the gateway's OpenAI-compatible route). |
| **Accepted by owner 2026-10-09 (ADR-0187 decision 106), reused** | numpy `2.5.4` | numpy: Zlib; `numpy.libs/libgfortran`: GPL-3.0-or-later WITH GCC-exception-3.1; `numpy.libs/libquadmath`: LGPL-2.1-or-later | The same numpy runtime code the modelscan image ships; decision 106 says garak reuses it. |
| **Accepted by owner 2026-10-10 (ADR-0187 open question 21; decision 193)** | as installed | PSF-2.0: CPython, `aiohappyeyeballs`, `defusedxml`, `typing_extensions`; MPL-2.0 (file-level copyleft, **admitted only while unmodified**): `certifi`, `mikeshardmind-base2048` (a direct garak dependency), `orjson`, `tqdm`; ZPL-2.1: `datetime`, `zope.interface`; MIT-0: `cffi`; CNRI-Python: `regex`; MIT-CMU: `pillow`; pillow's bundled `libfreetype` (FTL), `libharfbuzz` (MIT-Modern-Variant), `libjpeg` (IJG AND BSD-3-Clause AND Zlib), `libpng16` (libpng-2.0), `libtiff` (libtiff); torch's LLVM-exception and BSL-1.0 terms | All permissive or file-level; none is GPL, AGPL, SSPL or BUSL. Each entry in `licence-allow.json` says "accepted by owner 2026-10-10 (ADR-0187 decision 193)" with its reason; the four MPL-2.0 entries carry `"condition": "unmodified"`, and the gate admits them only when every file of the distribution matches its wheel RECORD hash (decision 194). The acceptance amends ADR-0176's list for these named licences in shipped engine images only. |
| How the gate treats them | — | — | `licence-gate.mjs` is the modelscan gate (decision 106) plus pinned readings and pillow's native-library table (decision 157) and conditions (decision 194). It denies anything outside the list that `licence-allow.json` does not name (a licence not named stays DENIED, even for a subject that has another admitted term), refuses an allow entry whose decision is neither "pending owner decision" nor a dated owner acceptance naming its ADR decision, refuses an MPL-2.0 entry without the `unmodified` condition, denies a conditional row whose condition fails, refuses a malformed reading, and fails on an allow entry or a reading that matches nothing installed (stale). |
| Python base image `python:3.12-slim-trixie` | digest `sha256:a6e34c59…dc11b1` (the modelscan image's) | CPython: PSF-2.0 (pending, above); Debian packages: various (the OS layer carries GPL-licensed system packages such as the shell and coreutils, as the gateway image does) | The runtime of both containers. pip is removed from it and from the venv. |
| Node.js binary, from the gateway image's base `node:22-trixie-slim` | the gateway image's digest (`sha256:154ba2f4…a98dfa`) | MIT (with its bundled dependencies' notices) | Runs the runner and worker shim. Only the `node` binary is copied in; no npm, npx or corepack. |
| `zod` (npm, a direct dependency of the shim) | `4.6.5` (the version `@regulait/shared` already locks; ADR-0192) | MIT | Validates the exchange's job and done files and the worker's self-test. |
| `write-file-atomic` 8.0.0 and `signal-exit` 4.1.0 (npm, through `@regulait/engine-runner`) | as locked | ISC | The runner's key (ADR-0188 S7; it replaced the runner token) and retained results are written durably; see `packages/engine-runner/THIRD_PARTY.md`. |
| `jose` 6.2.12 (npm, through `@regulait/engine-runner`) | as locked (exact) | MIT | ADR-0188 S7: the runner key's RFC 7638 thumbprint and the compact JWS a key rotation carries. No dependencies; no network. |
| `oauth4webapi` 3.8.8 (npm, through `@regulait/engine-runner`) | as locked (exact) | MIT | ADR-0188 S7: the runner's OAuth client (client_credentials with private_key_jwt and DPoP, then DPoP-bound requests). It calls only the gateway it is given; no discovery or JWKS fetch. |

Not shipped: no Hugging Face asset beyond the nine pre-seeded above (the probes that need another are declared
not run), no CyberSecEval file (open question 23), and no upstream image.

Open-source check (ADR-0176) for what B5-G wrote itself: garak is used, not rewritten — its own report format
(`report.jsonl`) is the only result source, its own probe metadata generates the catalogue's columns, and its own
OpenAI-compatible generator reaches the gateway. Our code is the governance part: which probes may run (licence and
provenance), the mapper's not-clean rules, the runner/worker split and the worker's self-test. No library parses
garak's report for us (it is JSON Lines; `JSON.parse` per line with our consistency checks). `pip-licenses` (MIT) was
not taken for the gate for the reason recorded for modelscan (it does not see bundled native libraries).
