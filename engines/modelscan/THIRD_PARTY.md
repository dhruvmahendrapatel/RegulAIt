# Third-party components — the modelscan engine image (`engines/modelscan`)

Open-source components the modelscan image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). The Python closure is pinned by
`engines/modelscan/requirements.txt` (every wheel by version and sha256) and installed with
`pip install --require-hashes --no-deps --only-binary :all:`; the runner and scanner shim (`packages/engine-modelscan`) is
pinned by `pnpm-lock.yaml`. Facts were read from the pinned wheels on 2026-10-09 (docs/research/R10-engine-admission.md
§modelscan, and ADR-0187 decisions 104 onward).

**Admission status: NOT ADMISSIBLE YET.** The image has not been built in an environment that can report its digest
(no Docker daemon where B5-M was built; CI's docker-build job builds it), the image-level scan (OS layer,
vulnerabilities, licences) has not run, the Python closure's advisories have not been checked (pip-audit or OSV at the
first build), and two of the six licences outside the ADR-0176 list (HDF5, CPython) still await an owner decision;
numpy's three were accepted by the owner on 2026-10-09 (below). The
shipped manifest carries no digest, so the engine cannot be enabled (ADR-0187 decision 3).

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `modelscan` (PyPI, github.com/protectai/modelscan) | `0.8.8` (released 2026-02-18; wheel sha256 `a1997df2…ad967e`, the hash R10 checked independently) | Apache-2.0 (its `tools/` carry MIT code from picklescan and BSD-style helpers from PyTorch) | The engine (ADR-0187 B5-M): it disassembles pickles (never loads them) and reads H5 attributes, and reports unsafe operators against a deny-list. Maintenance only: no release since 2026-02-18, so the 12-month rule lapses on 2027-02-18 (open question 3; the fallback is `modelaudit`, MIT). One local patch (`patches/format-names-from-settings.py`, decision 107): without it 0.8.8 scans nothing when its settings come from a file. Listed on the image label `org.regulait.patches`. The TensorFlow extra is NOT installed. |
| `h5py` | `3.16.0` | BSD-3-Clause; its wheel bundles HDF5 (`libhdf5`, `libhdf5_hl`: the HDF Group's BSD-style licence, **pending**), `libaec`/`libsz` (BSD-2-Clause) and LZF, PyTables, stdint and PSF notices for vendored code | modelscan's Keras H5 scanner (Lambda layers). A native parser of hostile bytes: it runs only in the no-network scanner container. |
| `numpy` | `2.5.3` | `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` (Zlib **accepted by owner**); its wheel bundles OpenBLAS (BSD-3-Clause), `libgfortran` (GPL-3.0-or-later WITH GCC-exception-3.1, **accepted by owner**) and `libquadmath` (LGPL-2.1-or-later, **accepted by owner**) | A hard dependency of modelscan (its pickle scanner imports it). modelscan 0.8.8's NumPy scanner calls an internal numpy function that numpy 2.x removed (decision 108), so modelscan is never handed a `.npy`: our own stdlib header check (`npy-header.py`, ADR-0187 decisions 180–184) decides numeric or object and hands an object array's pickle payload to modelscan's pickle scanner; a `.npz` is checked the same way member by member (`--npz`, Python's `zipfile`, decisions 219–224), so modelscan is never handed a `.npz` either. Pinning numpy 1.26 instead was rejected: its last release was 2024-02-05 (ADR-0176's 12-month rule). |
| `click` 8.5.0 (BSD-3-Clause), `rich` 14.3.4 (MIT), `markdown-it-py` 4.2.0 (MIT), `mdurl` 0.1.2 (MIT), `pygments` 2.21.0 (BSD-2-Clause), `tomlkit` 0.13.3 (MIT) | as listed | as listed | modelscan's CLI, console and settings parsing. |
| **Accepted by owner 2026-10-09 (ADR-0187 decision 106), a recorded exception to ADR-0176** | as installed | numpy: **Zlib** — a permissive licence, no copyleft; `numpy.libs/libgfortran`: **GPL-3.0-or-later WITH GCC-exception-3.1** — a runtime-library exception: the GCC Runtime Library Exception lets independent code use the GCC runtime without GPL obligations; `numpy.libs/libquadmath`: **LGPL-2.1-or-later** — an unmodified, dynamically linked LGPL library shipped as its own shared object | numpy's bundled runtime code, needed because numpy is a hard dependency of modelscan. Each entry in `licence-allow.json` reads "accepted by owner 2026-10-09 (ADR-0187 decision 106)" with its reason. The garak image reuses this decision for the same numpy. |
| **Still pending an owner decision** (ADR-0187 open question 15) | as installed | `h5py.libs/libhdf5` and `libhdf5_hl`: LicenseRef-HDF5 (the HDF Group's BSD-style licence); the CPython runtime: PSF-2.0 | Not yet put to the owner. Both are permissive. Each entry in `licence-allow.json` says exactly "pending owner decision". |
| How the gate treats them | — | — | `licence-gate.mjs` runs on the installed closure in the build. It denies anything outside the ADR-0176 list that `licence-allow.json` does not name, refuses an entry whose decision is neither "pending owner decision" nor a dated owner acceptance naming its ADR decision, and fails on an entry that matches nothing (stale). |
| Python base image `python:3.12-slim-trixie` | digest `sha256:a6e34c59…dc11b1` (CPython 3.12.15) | CPython: PSF-2.0 (still pending, above); Debian packages: various (the OS layer carries GPL-licensed system packages such as the shell and coreutils, as the gateway image does) | The runtime of both containers. pip is removed from it and from the venv. The OS-layer licence and vulnerability scan is Trivy's, in CI (ADR-0184), and has not run on this image yet. modelscan 0.8.8 requires Python < 3.13. |
| Node.js binary, from the gateway image's base `node:22-trixie-slim` | the gateway image's digest (`sha256:154ba2f4…a98dfa`) | MIT (with its bundled dependencies' notices) | Runs the runner and scanner shim. Only the `node` binary is copied in; no npm, npx or corepack. |
| `zod` (npm, a direct dependency of the shim) | `3.25.76` (the version `@regulait/shared` already locks) | MIT | Validates modelscan's report, the exchange's job and done files and the scanner's self-test. |
| `write-file-atomic` 8.0.0 and `signal-exit` 4.1.0 (npm, through `@regulait/engine-runner`) | as locked | ISC | The runner token and retained results are written durably; see `packages/engine-runner/THIRD_PARTY.md`. |
| `smol-toml` (npm, a DEV dependency of the shim only; not in the image) | `1.9.0` (released 2026-09-22) | BSD-3-Clause | The settings test parses the committed `modelscan-settings.toml` and compares it with `MODELSCAN_SETTINGS`. |

Open-source check (ADR-0176) for what B5-M wrote itself: format detection by magic bytes (`packages/shared/src/engines/
modelscan.ts`) — `file-type` (MIT) recognises zip, gzip and the like but not pickle protocols, PyTorch's legacy magic
pickle, a zip's PyTorch or Keras layout, or a safetensors header, and does not verify a safetensors header's offsets; the
safetensors format has no maintained JavaScript validator that checks the tiling rule. Both are short parsers of public
formats, written for the gateway's admission decision (a hard requirement: the format must be decided from content,
G19 2). The licence gate reads the installed `dist-info` metadata itself because `pip-licenses` (MIT) would add a package
to the image and does not inventory a wheel's bundled native libraries, which is the point of this gate.
