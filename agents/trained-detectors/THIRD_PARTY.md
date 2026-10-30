# Third-party content in the trained-detector image (ADR-0220, ADR-0176)

Everything below is pinned: the Python closure by version and sha256 in `requirements.txt` (generated from
`requirements.in` with `uv pip compile --generate-hashes`, linux x86_64, CPython 3.12), the model files by repository
revision and sha256 in `models.lock.json`. Nothing is downloaded at run time.

## Search record (open source first, ADR-0176)

What was looked for, and why these were chosen:

- **PII recogniser:** Presidio Analyzer (MIT) with the spaCy `en_core_web_sm` pipeline (MIT). Chosen over a single
  token-classification model because it pairs a trained NER model (names, places) with checksum-validated recognisers
  (cards, IBANs, national identifiers) and reports entity types, which become counts in the audit log. Considered:
  `dslim/bert-base-NER` (MIT, names/places only), GLiNER PII variants (Apache-2.0, heavier, less mature).
- **Prompt-injection classifier:** `protectai/deberta-v3-base-prompt-injection-v2` (Apache-2.0). Considered and
  rejected: Meta Prompt Guard (Llama community licence, not on the ADR-0176 list).
- **Harm classifier:** `unitary/toxic-bert` (Apache-2.0; the Detoxify "original" model, six labels: toxic,
  severe_toxic, obscene, threat, insult, identity_hate). Considered: RoBERTa toxicity models under OpenRAIL-style
  licences (not on the list).
- **Groundedness:** `vectara/hallucination_evaluation_model` (HHEM-2.1-Open, Apache-2.0) fits the licence rule but
  loads custom modelling code (`trust_remote_code`). It is **not** in this image yet: the custom code needs its own
  review and pinning, and groundedness needs retrieval context the dispatch path does not carry. Recorded follow-up.
- **Runtime:** PyTorch (CPU) and Hugging Face Transformers. ONNX Runtime (MIT) would shrink the image and is the
  recorded follow-up; it was not chosen for the first slice because the harm model ships no ONNX export.
- **HTTP server:** the Python standard library (`http.server`), so no web framework is added.

## Models (weights)

| Model | Revision | Licence | Training data note |
|---|---|---|---|
| protectai/deberta-v3-base-prompt-injection-v2 | `90c9989b1a342275dd0d1a95aad283c04e075671` | Apache-2.0 | Fine-tune of microsoft/deberta-v3-base (MIT) on public injection and benign-prompt datasets listed on its model card. |
| unitary/toxic-bert | `4d6c22e74ba2fdd26bc4f7238f50766b045a0d94` | Apache-2.0 | Trained on the Jigsaw toxic-comment data. |
| spaCy `en_core_web_sm` 3.8.0 (wheel) | sha256 `1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85` | MIT | Its `LICENSES_SOURCES` file lists the corpora it was trained on (including OntoNotes 5); the model is distributed under MIT. |

## Python closure

Inside the ADR-0176 list (MIT, Apache-2.0, BSD, ISC, public-domain dedications): annotated-doc, annotated-types, anyio,
blis, catalogue, charset-normalizer, click, cloudpathlib, confection, cymem, filelock, fsspec, h11, hf-xet, httpcore,
httpcore2, httpx, httpx2, huggingface-hub, idna, jinja2, markdown-it-py, markupsafe, mdurl, mpmath, murmurhash,
networkx, numpy (BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0), packaging, phonenumbers, preshed,
presidio-analyzer, protobuf, pydantic, pydantic-core, pygments, pyyaml, requests, requests-file, rich, safetensors,
sentencepiece, setuptools, shellingham, smart-open, spacy, spacy-legacy, spacy-loggers, srsly, sympy, thinc,
tldextract, tokenizers, torch 2.15.0+cpu (Apache-2.0, BSD, MIT, ISC, Zlib and BSL-1.0, the Boost licence), transformers,
truststore, typer, typing-inspection, urllib3, wasabi, weasel, wrapt.

**Outside the list — pending owner decision** (the same position the modelscan image records in its
`licence-allow.json`; none is modified, all are transitive):

| Package | Licence | Pulled in by |
|---|---|---|
| certifi | MPL-2.0 (file-level copyleft; unmodified) | requests, httpx |
| tqdm | MPL-2.0 AND MIT | huggingface-hub, transformers |
| regex | Apache-2.0 AND CNRI-Python | transformers |
| typing-extensions | PSF-2.0 | pydantic, torch and others |
| CPython 3.12 (base image) | PSF-2.0 | the runtime |

Until the owner decides, the image is documented and buildable but is not part of the shipped product image or the
air-gapped bundle; an operator who builds it accepts these terms for their own deployment.
