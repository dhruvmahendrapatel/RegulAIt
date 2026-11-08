# Third-party components — the skillscanner engine image (`engines/skillscanner`)

Open-source components the skillscanner image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a public-domain
dedication; maintained; pinned; works air-gapped). The Python closure is pinned by `engines/skillscanner/requirements.txt` (every
wheel by version and sha256) and installed with `pip install --require-hashes --no-deps --only-binary :all:`. Facts were
read from the pinned wheels and the sdist on 2026-11-07 (ADR-0242). `litellm` and `filelock` are overridden above the
upstream pins for published advisories (ADR-0242 §3).

**Admission status: NOT ADMISSIBLE YET.** The image builds and passes its licence gate and offline smoke scan (measured
locally, 2026-11-07), but it is not published: no digest is recorded in `engines/images.lock.json`, the image-level scan
(OS layer, vulnerabilities, licences) has not run in CI, and the closure's advisories have not been checked (phase 2,
ADR-0242 §6). The shipped manifest carries no digest, so the engine cannot be enabled (ADR-0187 decision 3).

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| Cisco skill-scanner 2.3.2: `cisco-ai-skill-scanner` 2.3.2 (wheel sha256 `0222d84c…16f0efa5`) | 2.3.2 | Apache-2.0 (LICENSE read from the sdist) | the engine: its core local analyzers only (ADR-0242 §2). |
| Python base image `python:3.12-slim-trixie` | digest `sha256:4840d514…b93a54` (CPython 3.12.16) | PSF-2.0 (accepted by owner, ADR-0187 decision 193); Debian packages: various | The runtime. pip is removed from it and from the venv. |
| Node.js binary from `node:22-trixie-slim` (build stage only) | digest `sha256:be1e2a3d…fb768c6` | MIT | Runs the licence gate during the build; it does not ship in the runtime stage. |

## The Python closure, as installed

| Package | Version | Licence |
|---|---|---|
| `aiohappyeyeballs` | 2.7.1 | PSF-2.0 (accepted by owner, ADR-0187) |
| `aiohttp` | 3.14.5 | Apache-2.0 AND MIT |
| `aiosignal` | 1.4.0 | Apache 2.0 |
| `annotated-doc` | 0.0.5 | MIT |
| `annotated-types` | 0.8.0 | MIT |
| `anthropic` | 0.125.0 | MIT |
| `anyio` | 4.16.0 | MIT |
| `attrs` | 26.1.0 | MIT |
| `boto3` | 1.43.126 | Apache-2.0 |
| `botocore` | 1.43.126 | Apache-2.0 |
| `certifi` | 2026.10.23 | MPL-2.0 (accepted by owner, ADR-0187) |
| `cffi` | 2.1.1 | MIT-0 (accepted by owner, ADR-0187) |
| `charset-normalizer` | 3.5.2 | MIT |
| `cisco-ai-skill-scanner` | 2.3.2 | Apache-2.0 |
| `click` | 8.5.1 | BSD-3-Clause |
| `colorclass` | 2.2.2 | MIT |
| `confusable-homoglyphs` | 3.3.1 | MIT |
| `cryptography` | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| `distro` | 1.9.0 | Apache License, Version 2.0 |
| `docstring_parser` | 0.18.0 | MIT |
| `easygui` | 0.98.3 | BSD-3-Clause |
| `fastapi` | 0.162.0 | MIT |
| `fastuuid` | 0.14.0 | BSD-3-Clause |
| `filelock` | 4.2.9 | MIT |
| `flatbuffers` | 25.12.19 | Apache 2.0 |
| `frozenlist` | 1.8.0 | Apache-2.0 |
| `fsspec` | 2026.9.0 | BSD-3-Clause |
| `h11` | 0.16.0 | MIT |
| `h2` | 4.4.1 | MIT |
| `hf-xet` | 1.8.0 | Apache-2.0 |
| `hpack` | 4.2.0 | MIT |
| `httpcore` | 1.0.9 | BSD-3-Clause |
| `httptools` | 0.9.0 | MIT |
| `httpx` | 0.28.1 | BSD-3-Clause |
| `huggingface_hub` | 1.33.0 | Apache-2.0 |
| `hyperframe` | 6.1.0 | MIT |
| `idna` | 3.20 | BSD-3-Clause |
| `importlib_metadata` | 8.9.0 | Apache-2.0 |
| `Jinja2` | 3.1.6 | BSD-3-Clause |
| `jiter` | 0.19.0 | MIT |
| `jmespath` | 1.1.0 | MIT |
| `jsonschema` | 4.26.0 | MIT |
| `jsonschema-specifications` | 2025.9.1 | MIT |
| `linkify-it-py` | 2.2.0 | MIT |
| `litellm` | 1.108.2 | MIT |
| `magika` | 1.0.3 | Apache-2.0 |
| `markdown-it-py` | 4.2.0 | MIT |
| `MarkupSafe` | 3.0.4 | BSD-3-Clause |
| `mdit-py-plugins` | 0.6.1 | MIT |
| `mdurl` | 0.1.2 | MIT |
| `msoffcrypto-tool` | 6.1.0 | MIT |
| `multidict` | 7.2.1 | Apache-2.0 |
| `numpy` | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 (accepted by owner, ADR-0187) |
| `olefile` | 0.47 | BSD-2-Clause |
| `oletools` | 0.60.2 | BSD-2-Clause |
| `onnxruntime` | 1.31.1 | MIT License |
| `openai` | 2.54.0 | Apache-2.0 |
| `opentelemetry-api` | 1.45.2 | Apache-2.0 |
| `packaging` | 26.3 | Apache-2.0 OR BSD-2-Clause |
| `pdfid` | 1.1.3 | MIT |
| `platformdirs` | 4.14.5 | MIT |
| `propcache` | 0.5.4 | Apache-2.0 |
| `protobuf` | 6.33.6 | BSD-3-Clause |
| `pycparser` | 3.12 | BSD-3-Clause |
| `pydantic` | 2.14.3 | MIT |
| `pydantic_core` | 2.50.4 | MIT |
| `pydantic-settings` | 2.16.2 | MIT |
| `Pygments` | 2.21.0 | BSD-2-Clause |
| `PyJWT` | 2.15.1 | MIT |
| `pyparsing` | 3.3.3 | MIT |
| `python-dateutil` | 2.9.0.post0 | Dual License |
| `python-dotenv` | 1.2.4 | BSD-3-Clause |
| `python-frontmatter` | 1.3.0 | MIT |
| `python-multipart` | 0.0.33 | Apache-2.0 |
| `PyYAML` | 6.0.3 | MIT |
| `referencing` | 0.37.0 | MIT |
| `regex` | 2026.11.7 | Apache-2.0 AND CNRI-Python (accepted by owner, ADR-0187) |
| `requests` | 2.34.2 | Apache-2.0 |
| `rich` | 14.3.4 | MIT |
| `rpds-py` | 2026.9.1 | MIT |
| `s3transfer` | 0.19.3 | Apache License 2.0 |
| `six` | 1.17.0 | MIT |
| `sniffio` | 1.3.1 | MIT OR Apache-2.0 |
| `starlette` | 1.10.0 | BSD-3-Clause |
| `tabulate` | 0.10.0 | MIT |
| `textual` | 8.2.8 | MIT |
| `tiktoken` | 0.14.0 | MIT |
| `tokenizers` | 0.23.3 | Apache-2.0 |
| `tqdm` | 4.70.1 | MPL-2.0 AND MIT (accepted by owner, ADR-0187) |
| `typing_extensions` | 4.16.0 | PSF-2.0 (accepted by owner, ADR-0187) |
| `typing-inspection` | 0.4.5 | MIT |
| `urllib3` | 2.8.0 | MIT |
| `uvicorn` | 0.54.0 | BSD-3-Clause |
| `uvloop` | 0.23.0 | MIT OR Apache-2.0 |
| `watchfiles` | 1.3.0 | MIT |
| `websockets` | 17.4 | BSD-3-Clause |
| `yara-x` | 1.23.0 | BSD-3-Clause |
| `yarl` | 1.25.1 | Apache-2.0 |
| `zipp` | 4.1.2 | MIT |
| **excluded:** `pcodedmp` | 1.2.6 | GPL-3.0: NOT installed (ADR-0242 §3); oletools' optional P-code path, which skill-scanner never takes |
| **pruned:** `oletools/thirdparty/xxxswf`, `oletools/pyxswf.py` | 0.60.2 | no licence stated: removed in the build |
| oletools' own `thirdparty/` kept: `oledump` (public-domain dedication, Didier Stevens), `tablestream` and `xglob` (BSD-2-Clause), `prettytable` (BSD-3-Clause) | 0.60.2 | as listed (ADR-0242 open question 4) |
| `yara-x`'s statically linked Rust crates (from the wheel's CycloneDX SBOM) | 1.23.0 | mostly MIT / Apache-2.0; also Apache-2.0 WITH LLVM-exception, Zlib and Unicode-3.0 terms, **pending an owner decision** (ADR-0242 open question 3) |
| the Go CEL helper (`skill_scanner/core/cel/_bin`), REBUILT in the image from the hashed sdist with Go 1.27.3 (the wheel's was Go 1.27.1, with stdlib advisories) | 2.3.2 | its Go modules, per the sdist's `go.mod`: cel-go v0.32.0 and cel.dev/expr (Apache-2.0), protobuf-go and golang.org/x/exp (BSD-3-Clause), antlr4-go (BSD-3-Clause), genproto (Apache-2.0), go.yaml.in/yaml/v3 (MIT and Apache-2.0), and the Go standard library (BSD-3-Clause) |

Cloud clients in this closure (`litellm`, `openai`, `anthropic`) are hard dependencies upstream. The driver never builds an
analyzer that uses them, refuses to start with any cloud credential set, sets `LITELLM_LOCAL_MODEL_COST_MAP=True` (litellm
otherwise fetches a remote price map at import), and the task runs with no network (ADR-0242 §2–§3).
