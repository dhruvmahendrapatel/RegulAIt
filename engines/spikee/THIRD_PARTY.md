# Third-party components — the spikee engine image (`engines/spikee`)

What the image ships besides RegulAIt's own shim (`@regulait/engine-spikee`, whose npm components are in
`packages/engine-spikee/THIRD_PARTY.md`). ADR-0176 admission rules: MIT, Apache-2.0, BSD, ISC or a public-domain
dedication; maintained; pinned; works air-gapped. Every Python distribution is pinned by version and sha256 in
`requirements.txt` and judged at build time by `licence-gate.mjs` on the INSTALLED closure (a licence outside the list
fails the build unless `licence-allow.json` admits it).

## The engine

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `spikee` (PyPI, github.com/WithSecureLabs/spikee, © WithSecure) | `0.9.4` (sha256 `3768463052de5d89f94ec4a4c4dd11c492c6e2f7b31e09b45eade9e57ffaa3d6`, no extras) | Apache-2.0 | Indirect prompt-injection testing (ADR-0245): `spikee generate` builds payload-in-document datasets from its own seed folders, offline; `spikee test` sends them to this build's gateway target and judges each reply with its local `canary`/`regex` judges. |

## Bundled data (inside the spikee wheel)

| Data | Source and licence | In the image? |
|---|---|---|
| `seeds-cybersec-2026-01`, `seeds-llm-mailbox`, `seeds-sysmsg-extraction-2025-04`, `seeds-mini-test` | Written by WithSecure, inside the Apache-2.0 wheel; checked at build time against `SPIKEE_LOCAL_SEEDS_SHA256` | Yes: the four local datasets. Two `poetry` jailbreaks in cybersec-2026-01 cite `AutomateTim/poetry-jailbreak-simple-sample` (a Hub dataset whose card states no licence): they stay in the file but are never generated (`--jailbreak-filter`, an allow-list of the other 20 types). |
| `adv_suffixes.jsonl` (in the local seeds) | Two suffixes cite `tml-epfl/llm-adaptive-attacks` attack logs | Shipped, never read: this build never passes `--include-fixes`. |
| `seeds-harmful-instructions-only`, `seeds-investment-advice`, `seeds-investment-advice-fp` | WithSecure; judged by an LLM judge (a hosted model); investment-advice's jailbreaks cite hiddenlayer.com | Shipped, never planned (`cloud_only`). |
| `fetch_and_convert_dataset.py` in five seed folders | Download TrustAIRLab/in-the-wild-jailbreak-prompts, Simsonsun/JailbreakPrompts, lmsys/toxic-chat (CC-BY-NC-4.0) and the gated wildguardmix from the Hub | **Removed** (`excluded-data.txt`). |
| `workspace/judges/llm_judge_*.py` | WithSecure; call a hosted model and load `.env` | **Removed** (`excluded-data.txt`). |

## Licences outside the ADR-0176 list (admitted by `licence-allow.json`)

Each is a licence the owner accepted for the garak image (ADR-0187 decisions 106 and 193) on the same or an equivalent
component. The allow file marks every one "reused from ADR-0187 decision N for spikee; owner to confirm (ADR-0245)":
admitted for the build, NOT a recorded owner acceptance for spikee.

| Subject | Licence | Garak decision |
|---|---|---|
| `python` (the base image's CPython runtime) | PSF-2.0 | 193 |
| `aiohappyeyeballs` | PSF-2.0 | 193 |
| `typing_extensions` | PSF-2.0 | 193 |
| `certifi` | MPL-2.0 (only while unmodified: RECORD hash check) | 193 |
| `tqdm` | MPL-2.0 AND MIT (MPL only while unmodified) | 193 |
| `regex` | Apache-2.0 AND CNRI-Python | 193 |
| `numpy` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 (Zlib admitted) | 106 |
| `numpy.libs/libgfortran` | GPL-3.0-or-later WITH GCC-exception-3.1 | 106 |
| `numpy.libs/libquadmath` | LGPL-2.1-or-later | 106 |

Not scanned by the gate (CI's image scan covers them): the shared objects `pyarrow` ships inside its own package
directory (Arrow and its statically linked dependencies, listed in pyarrow's LICENSE.txt and NOTICE.txt), and the base
image's OS layer.

## The Python closure (all 70 distributions, as the gate reads them)

| Distribution | Version | Licence |
|---|---|---|
| `aiohappyeyeballs` | `2.7.1` | PSF-2.0 |
| `aiohttp` | `3.14.5` | Apache-2.0 AND MIT |
| `aiosignal` | `1.4.0` | Apache-2.0 |
| `annotated-types` | `0.8.0` | MIT |
| `anthropic` | `0.125.0` | MIT |
| `any-llm-sdk` | `1.43.0` | Apache-2.0 |
| `anyio` | `4.16.0` | MIT |
| `attrs` | `26.1.0` | MIT |
| `blinker` | `1.9.0` | MIT |
| `certifi` | `2026.10.23` | MPL-2.0 |
| `charset-normalizer` | `3.5.2` | MIT |
| `click` | `8.5.1` | BSD-3-Clause |
| `datasets` | `4.8.4` | Apache-2.0 |
| `dill` | `0.4.1` | BSD-3-Clause |
| `distro` | `1.9.0` | Apache-2.0 |
| `docstring_parser` | `0.18.0` | MIT |
| `filelock` | `4.2.9` | MIT |
| `flask` | `3.1.3` | BSD-3-Clause |
| `frozenlist` | `1.8.0` | Apache-2.0 |
| `fsspec` | `2026.2.0` | BSD-3-Clause |
| `h11` | `0.16.0` | MIT |
| `hf-xet` | `1.8.0` | Apache-2.0 |
| `httpcore2` | `2.16.0` | BSD-3-Clause |
| `httpcore` | `1.0.9` | BSD-3-Clause |
| `httpx2` | `2.16.0` | BSD-3-Clause |
| `httpx` | `0.28.1` | BSD-3-Clause |
| `huggingface_hub` | `1.33.0` | Apache-2.0 |
| `idna` | `3.20` | BSD-3-Clause |
| `inquirerpy` | `0.3.4` | MIT |
| `itsdangerous` | `2.2.0` | BSD-3-Clause |
| `jinja2` | `3.1.6` | BSD-3-Clause |
| `jiter` | `0.19.0` | MIT |
| `markdown-it-py` | `4.2.0` | MIT |
| `markdown` | `3.10.2` | BSD-3-Clause |
| `markupsafe` | `3.0.4` | BSD-3-Clause |
| `mdurl` | `0.1.2` | MIT |
| `multidict` | `7.2.1` | Apache-2.0 |
| `multiprocess` | `0.70.19` | BSD-3-Clause |
| `numpy` | `2.5.4` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| `openai` | `3.46.0` | Apache-2.0 |
| `openresponses-types` | `2.4.0` | Apache-2.0 |
| `packaging` | `26.3` | Apache-2.0 OR BSD-2-Clause |
| `pandas` | `3.0.1` | BSD-3-Clause AND Apache-2.0 AND MIT AND BSD-2-Clause |
| `pfzy` | `0.3.4` | MIT |
| `prompt_toolkit` | `3.0.53` | BSD-3-Clause |
| `propcache` | `0.5.4` | Apache-2.0 |
| `pyarrow` | `26.0.1` | Apache-2.0 |
| `pydantic_core` | `2.50.4` | MIT |
| `pydantic` | `2.14.3` | MIT |
| `pygments` | `2.21.0` | BSD-2-Clause |
| `python-dateutil` | `4.0.0` | BSD-3-Clause |
| `python-dotenv` | `1.2.2` | BSD-3-Clause |
| `pyyaml` | `6.0.3` | MIT |
| `regex` | `2026.11.7` | Apache-2.0 AND CNRI-Python |
| `requests` | `2.33.0` | Apache-2.0 |
| `rich` | `14.3.3` | MIT |
| `sniffio` | `1.3.1` | MIT OR Apache-2.0 |
| `spikee` | `0.9.4` | Apache-2.0 |
| `tabulate` | `0.9.0` | MIT |
| `tiktoken` | `0.12.0` | MIT |
| `tqdm` | `4.67.3` | MPL-2.0 AND MIT |
| `truststore` | `0.10.5` | MIT |
| `typing-inspection` | `0.4.5` | MIT |
| `typing_extensions` | `4.16.0` | PSF-2.0 |
| `tzdata` | `2026.6` | Apache-2.0 |
| `urllib3` | `2.8.0` | MIT |
| `wcwidth` | `0.9.4` | MIT |
| `werkzeug` | `3.1.9` | BSD-3-Clause |
| `xxhash` | `4.0.2` | BSD-2-Clause |
| `yarl` | `1.25.1` | Apache-2.0 |
