# Third-party components — the mcpscanner engine image (`engines/mcpscanner`)

Open-source components the mcpscanner image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a public-domain
dedication; maintained; pinned; works air-gapped). The Python closure is pinned by `engines/mcpscanner/requirements.txt` (every
wheel by version and sha256) and installed with `pip install --require-hashes --no-deps --only-binary :all:`. Facts were
read from the pinned wheels and the sdist on 2026-11-07 (ADR-0242).

**Admission status: NOT ADMISSIBLE YET.** The image builds and passes its licence gate and offline smoke scan (measured
locally, 2026-11-07), but it is not published: no digest is recorded in `engines/images.lock.json`, the image-level scan
(OS layer, vulnerabilities, licences) has not run in CI, and the closure's advisories have not been checked (phase 2,
ADR-0242 §6). The shipped manifest carries no digest, so the engine cannot be enabled (ADR-0187 decision 3).

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| Cisco mcp-scanner 4.8.7: `cisco-ai-mcp-scanner` 4.8.7 (wheel sha256 `55142609…8906350`) | 4.8.7 | Apache-2.0 (LICENSE read from the sdist) | the engine: its offline `static` mode with the YARA and schema analyzers only (ADR-0242 §2). |
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
| `anyio` | 4.16.0 | MIT |
| `attrs` | 26.1.0 | MIT |
| `boolean.py` | 5.0 | BSD-2-Clause |
| `CacheControl` | 0.14.4 | Apache-2.0 |
| `certifi` | 2026.10.23 | MPL-2.0 (accepted by owner, ADR-0187) |
| `cffi` | 2.1.1 | MIT-0 (accepted by owner, ADR-0187) |
| `charset-normalizer` | 3.5.2 | MIT |
| `cisco-ai-mcp-scanner` | 4.8.7 | Apache-2.0 |
| `click` | 8.5.1 | BSD-3-Clause |
| `cryptography` | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| `cyclonedx-python-lib` | 11.12.0 | Apache-2.0 |
| `defusedxml` | 0.7.1 | PSF-2.0 (accepted by owner, ADR-0187) |
| `distro` | 1.9.0 | Apache License, Version 2.0 |
| `expandvars` | 1.1.2 | MIT |
| `fastapi` | 0.162.0 | MIT |
| `fastuuid` | 0.14.0 | BSD-3-Clause |
| `filelock` | 4.2.9 | MIT |
| `frozenlist` | 1.8.0 | Apache-2.0 |
| `fsspec` | 2026.9.0 | BSD-3-Clause |
| `h11` | 0.16.0 | MIT |
| `hf-xet` | 1.8.0 | Apache-2.0 |
| `httpcore` | 1.0.9 | BSD-3-Clause |
| `httpcore2` | 2.16.0 | BSD-3-Clause |
| `httpx` | 0.28.1 | BSD-3-Clause |
| `httpx2` | 2.16.0 | BSD-3-Clause |
| `huggingface_hub` | 2.4.0 | Apache-2.0 |
| `idna` | 3.20 | BSD-3-Clause |
| `importlib_metadata` | 8.9.0 | Apache-2.0 |
| `Jinja2` | 3.1.6 | BSD-3-Clause |
| `jiter` | 0.19.0 | MIT |
| `jsonschema` | 4.26.0 | MIT |
| `jsonschema-specifications` | 2025.9.1 | MIT |
| `license-expression` | 30.4.4 | Apache-2.0 |
| `litellm` | 1.93.2 | MIT |
| `markdown-it-py` | 4.2.0 | MIT |
| `MarkupSafe` | 3.0.4 | BSD-3-Clause |
| `mcp` | 2.3.0 | MIT |
| `mcp-types` | 2.3.0 | MIT |
| `mdurl` | 0.1.2 | MIT |
| `msgpack` | 1.2.4 | Apache-2.0 |
| `multidict` | 7.2.1 | Apache-2.0 |
| `openai` | 2.54.0 | Apache-2.0 |
| `opentelemetry-api` | 1.45.2 | Apache-2.0 |
| `packageurl-python` | 0.17.6 | MIT |
| `packaging` | 26.3 | Apache-2.0 OR BSD-2-Clause |
| `pip_api` | 0.0.35 | Apache-2.0 |
| `pip_audit` | 2.10.1 | Apache-2.0 |
| `pip-requirements-parser` | 32.0.1 | MIT |
| `platformdirs` | 4.14.5 | MIT |
| `propcache` | 0.5.4 | Apache-2.0 |
| `puremagic` | 2.2.0 | MIT |
| `py-serializable` | 2.2.0 | Apache-2.0 |
| `pycparser` | 3.12 | BSD-3-Clause |
| `pydantic` | 2.14.3 | MIT |
| `pydantic_core` | 2.50.4 | MIT |
| `Pygments` | 2.21.0 | BSD-2-Clause |
| `PyJWT` | 2.15.1 | MIT |
| `pyparsing` | 3.3.3 | MIT |
| `python-dotenv` | 1.2.4 | BSD-3-Clause |
| `python-multipart` | 0.0.33 | Apache-2.0 |
| `PyYAML` | 6.0.3 | MIT |
| `referencing` | 0.37.0 | MIT |
| `regex` | 2026.11.7 | Apache-2.0 AND CNRI-Python (accepted by owner, ADR-0187) |
| `requests` | 2.34.2 | Apache-2.0 |
| `rich` | 15.0.0 | MIT |
| `rpds-py` | 2026.9.1 | MIT |
| `shellingham` | 1.5.4 | ISC License |
| `sniffio` | 1.3.1 | MIT OR Apache-2.0 |
| `sortedcontainers` | 2.4.0 | Apache 2.0 |
| `sse-starlette` | 3.6.0 | BSD-3-Clause |
| `starlette` | 1.10.0 | BSD-3-Clause |
| `tiktoken` | 0.14.0 | MIT |
| `tokenizers` | 0.23.3 | Apache-2.0 |
| `tomli` | 2.5.0 | MIT |
| `tomli_w` | 1.2.0 | MIT |
| `tqdm` | 4.70.1 | MPL-2.0 AND MIT (accepted by owner, ADR-0187) |
| `tree-sitter` | 0.25.2 | MIT |
| `tree-sitter-c-sharp` | 0.23.5 | MIT |
| `tree-sitter-go` | 0.25.0 | MIT |
| `tree-sitter-java` | 0.23.5 | MIT |
| `tree-sitter-javascript` | 0.25.0 | MIT |
| `tree-sitter-kotlin` | 1.1.0 | MIT |
| `tree-sitter-php` | 0.25.1 | MIT |
| `tree-sitter-python` | 0.25.0 | MIT |
| `tree-sitter-ruby` | 0.23.1 | MIT |
| `tree-sitter-rust` | 0.24.2 | MIT |
| `tree-sitter-typescript` | 0.23.2 | MIT |
| `truststore` | 0.10.5 | MIT |
| `typer` | 0.28.0 | MIT |
| `typing_extensions` | 4.16.0 | PSF-2.0 (accepted by owner, ADR-0187) |
| `typing-inspection` | 0.4.5 | MIT |
| `urllib3` | 2.8.0 | MIT |
| `uvicorn` | 0.54.0 | BSD-3-Clause |
| `yarl` | 1.25.1 | Apache-2.0 |
| `zipp` | 4.1.2 | MIT |
| `yara-python` (built from its sdist, sha256 `4c682170…6415b9c`, in the image; NOT a wheel) | 4.5.4 | Apache-2.0; bundles the YARA library (BSD-3-Clause). Built with NO OpenSSL: the 4.5.4 wheel bundles OpenSSL 1.1.1w (end of life). |
| `setuptools` (build only, never ships) | 84.2.1 | MIT |

Cloud clients in this closure (`litellm`, `openai`) are hard dependencies upstream. The driver never builds an
analyzer that uses them, refuses to start with any cloud credential set, sets `LITELLM_LOCAL_MODEL_COST_MAP=True` (litellm
otherwise fetches a remote price map at import), and the task runs with no network (ADR-0242 §2–§3).
