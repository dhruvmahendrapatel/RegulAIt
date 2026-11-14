# Third-party content in the trained-detector image (ADR-0220, ADR-0247, ADR-0176)

Everything below is pinned: the runtime Python closure by version and sha256 in `requirements.txt` (generated from
`direct-requirements.txt` with `uv pip compile --generate-hashes --exclude-newer 2026-10-31`, linux x86_64, CPython 3.12),
the build-time export closure the same way in `export-requirements.txt`, and the model files by repository revision and
sha256 in `models.lock.json`. Nothing is downloaded at run time.

## Search record (open source first, ADR-0176)

What was looked for, and why these were chosen:

- **PII recogniser:** Presidio Analyzer (MIT) with the spaCy `en_core_web_sm` pipeline (MIT). Chosen over a single
  token-classification model because it pairs a trained NER model (names, places) with checksum-validated recognisers
  (cards, IBANs, national identifiers) and reports entity types, which become counts in the audit log. Considered:
  `dslim/bert-base-NER` (MIT, names/places only), GLiNER PII variants (Apache-2.0, heavier, less mature).
- **Prompt-injection classifier (ADR-0247, P28):** `leolee99/PIGuard` (MIT; the model formerly published as
  InjecGuard), a DeBERTa-v3-base fine-tune trained against over-defense, is the default. `protectai/deberta-v3-base-prompt-injection-v2`
  (Apache-2.0) stays as the build-time alternative (`--build-arg INJECTION_MODEL=protectai`). PIGuard's repository
  loads through custom modelling code; that code is **never run**: the build rebuilds the same network from stock
  Transformers classes (`DebertaV2Model` plus one linear layer over the first token) and checks parity. Surveyed and
  measured on the ADR-0244 baselines (ADR-0247 has the table): `deepset/deberta-v3-base-injection` (MIT) and
  `fmops/distilbert-prompt-injection` (Apache-2.0) flag 70% or more of benign prompts; `jackhhao/jailbreak-classifier`
  (Apache-2.0) is a jailbreak classifier that misses half of AgentDojo's injections. Excluded on licence or access:
  Meta's Prompt Guard 1 and 2 (Llama community licences), `qualifire/prompt-injection-sentinel` (licence "other",
  gated), `testsavantai/prompt-injection-defender-*` (no licence), `protectai/deberta-v3-small-prompt-injection-v2`
  (gated).
- **Harm classifier:** `unitary/toxic-bert` (Apache-2.0; the Detoxify "original" model, six labels mapped to
  RegulAIt's own labels in `HARM_LABELS.md`). Kept by ADR-0247. Considered: `ibm-granite/granite-guardian-hap-38m` and
  `-125m` (Apache-2.0, one hate/abuse/profanity score, no categories), `unitary/unbiased-toxic-roberta` (Apache-2.0,
  adds identity labels), and excluded: `KoalaAI/Text-Moderation`, `s-nlp/roberta_toxicity_classifier` and
  `textdetox/xlmr-large-toxicity-classifier-v2` (OpenRAIL licences, not on the list), Llama Guard (Llama licence),
  ShieldGemma (Gemma terms), and 7B-class guard models such as WildGuard (Apache-2.0 but too large for CPU).
- **Groundedness:** `vectara/hallucination_evaluation_model` (HHEM-2.1-Open, Apache-2.0) fits the licence rule but
  loads custom modelling code (`trust_remote_code`). It is **not** in this image yet: the custom code needs its own
  review and pinning, and groundedness needs retrieval context the dispatch path does not carry. Recorded follow-up.
- **Runtime (ADR-0247):** ONNX Runtime (MIT) and Hugging Face `tokenizers` (Apache-2.0). PyTorch and Transformers run
  only in the build's export stage, which writes the ONNX graphs; neither is in the runtime image.
- **HTTP server:** the Python standard library (`http.server`), so no web framework is added.

## Models (weights)

| Model | Revision | Licence | Training data note |
|---|---|---|---|
| leolee99/PIGuard (default) | `dd78b24e330193a22d2293ac66922dd4f982f563` | MIT (model card; the code repository `leolee99/PIGuard` is MIT, © 2024 Hao Li) | Fine-tune of microsoft/deberta-v3-base (MIT). Its published training set (`datasets/train.json` in the code repository, 76,735 rows from 22 sources) **includes sources under CC BY-NC 4.0 (tatsu-lab Alpaca, 4,000 rows; HuggingFaceH4 no_robots, 1,500 rows) and sources with no stated licence**, plus 435 LLM-generated rows. The weights are MIT; whether a non-commercial training licence reaches the weights is an open legal question, recorded for the owner in ADR-0247. |
| protectai/deberta-v3-base-prompt-injection-v2 (alternative) | `90c9989b1a342275dd0d1a95aad283c04e075671` | Apache-2.0 | Fine-tune of microsoft/deberta-v3-base (MIT) on public datasets its card lists by licence: MIT, Apache-2.0, CC0, CC-BY-3.0, CC-BY-4.0 and six with no licence (treated as public by the publisher). |
| unitary/toxic-bert | `4d6c22e74ba2fdd26bc4f7238f50766b045a0d94` | Apache-2.0 | Trained on the Jigsaw toxic-comment data (Wikipedia talk-page comments; Kaggle competition terms). |
| spaCy `en_core_web_sm` 3.8.0 (wheel) | sha256 `1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85` | MIT | Its `LICENSES_SOURCES` file lists the corpora it was trained on (including OntoNotes 5); the model is distributed under MIT. |

## Python closure (runtime image, `requirements.txt`)

Inside the ADR-0176 list (MIT, Apache-2.0, BSD, ISC, public-domain dedications): annotated-doc, annotated-types, anyio,
blis, catalogue, charset-normalizer, click, cloudpathlib, confection, cymem, filelock, flatbuffers (Apache-2.0), fsspec,
h11, hf-xet, httpcore, httpcore2, httpx, httpx2, huggingface-hub, idna, jinja2, markdown-it-py, markupsafe, mdurl,
murmurhash, numpy (BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0), onnxruntime (MIT), packaging, phonenumbers,
preshed, presidio-analyzer, protobuf, pydantic, pydantic-core, pygments, pyyaml, requests, requests-file, rich,
setuptools, shellingham, smart-open, spacy, spacy-legacy, spacy-loggers, srsly, thinc, tldextract, tokenizers,
truststore, typer, typing-inspection, urllib3, wasabi, weasel, wrapt. ADR-0247 removed torch, transformers,
safetensors, sentencepiece, sympy, mpmath and networkx from the runtime image.

## Export closure (build stage only, `export-requirements.txt`; never in the runtime image)

torch 2.15.0+cpu (Apache-2.0, BSD, MIT, ISC, Zlib and BSL-1.0), transformers, safetensors, sentencepiece, onnx
(Apache-2.0), ml-dtypes (Apache-2.0), onnxruntime, tokenizers, numpy, sympy, mpmath, networkx and their small
dependencies, all inside the list except the transitive packages in the next table (certifi is not pulled in here).

**Outside the list — pending owner decision** (the same position the modelscan image records in its
`licence-allow.json`; none is modified, all are transitive):

| Package | Licence | Pulled in by |
|---|---|---|
| certifi | MPL-2.0 (file-level copyleft; unmodified) | requests, httpx |
| tqdm | MPL-2.0 AND MIT | huggingface-hub, spacy (and transformers in the export stage) |
| regex | Apache-2.0 AND CNRI-Python | presidio-analyzer (and transformers in the export stage) |
| typing-extensions | PSF-2.0 | pydantic, huggingface-hub and others (torch in the export stage) |
| CPython 3.12 (base image) | PSF-2.0 | the runtime |

Until the owner decides, the image is documented and buildable but is not part of the shipped product image or the
air-gapped bundle; an operator who builds it accepts these terms for their own deployment.
