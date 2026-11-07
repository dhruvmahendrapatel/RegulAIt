# ADR-0220, ADR-0247 — the trained-detector service image (reference implementation of the guardrail scorer).
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f agents/trained-detectors/Dockerfile -t regulait/trained-detectors:0.2.0 .
#   docker build --build-arg INJECTION_MODEL=protectai ...   # the alternative injection classifier (ADR-0247)
#
# What the build does, and what the image never does:
#   - stage `weights` downloads exactly the model files and the spaCy model wheel that models.lock.json names, at
#     pinned revisions, and fails on any sha256 mismatch (fetch_models.py, standard library only). This is the ONLY
#     network the image ever needs; an air-gapped site builds once where the files are reachable (or mirrors them)
#     and moves the image.
#   - stage `export` (ADR-0247) installs export-requirements.txt (hash-locked, CPU-only torch and Transformers) and
#     runs export_onnx.py OFFLINE over the verified files: each classifier becomes model.onnx + tokenizer.json +
#     labels.json, built from stock Transformers classes (never the repository's own code), and the build fails
#     unless the ONNX path matches PyTorch on fixed probes (same token ids, probabilities within 1e-4).
#   - stage `closure` installs the RUNTIME closure from requirements.txt (every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`): ONNX Runtime, tokenizers, Presidio and spaCy; no torch,
#     no Transformers. pip is removed afterwards.
#   - the runtime stage carries that venv, the exported models and the service code, runs as a non-root user, and
#     sets HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE as a second guard.
# Size: about 1.7 GB (a ~410 MB venv and ~1.1 GB of ONNX weights). It is not built in CI (see README.md).
#
# linux/amd64 ONLY: the hashes in both lockfiles are the cp312 manylinux x86_64 wheels.

# piguard (default, MIT) or protectai (Apache-2.0): the injection classifier this image bakes (ADR-0247)
ARG INJECTION_MODEL=piguard

# ---- stage 1: the pinned model files ---------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS weights
ARG INJECTION_MODEL
WORKDIR /build
COPY agents/trained-detectors/fetch_models.py agents/trained-detectors/models.lock.json ./
RUN python3 -I fetch_models.py models.lock.json /opt/models "$INJECTION_MODEL"

# ---- stage 1b: ONNX export, offline, parity-checked (ADR-0247) ----------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS export
ARG INJECTION_MODEL
WORKDIR /build
COPY agents/trained-detectors/export-requirements.txt ./
RUN python3 -m venv /xvenv \
 && /xvenv/bin/pip install --no-cache-dir --require-hashes --no-deps --only-binary :all: \
      --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu \
      -r export-requirements.txt
COPY agents/trained-detectors/detector_core.py agents/trained-detectors/fetch_models.py \
     agents/trained-detectors/export_onnx.py agents/trained-detectors/models.lock.json ./
COPY --from=weights /opt/models /opt/models
RUN HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    /xvenv/bin/python3 -I export_onnx.py models.lock.json /opt/models "$INJECTION_MODEL"

# ---- stage 2: the Python closure -------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
WORKDIR /build
COPY agents/trained-detectors/requirements.txt ./
COPY --from=weights /opt/models/wheels /build/wheels
RUN python3 -m venv /venv \
 && /venv/bin/pip install --no-cache-dir --require-hashes --no-deps --only-binary :all: \
      --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu \
      -r requirements.txt \
 # the spaCy model wheel was sha256-verified by fetch_models.py
 && /venv/bin/pip install --no-cache-dir --no-deps --no-index /build/wheels/*.whl \
 && /venv/bin/pip uninstall -y pip

# ---- stage 3: runtime ------------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin detector
COPY --from=closure /venv /venv
COPY --from=export --chown=root:root /opt/models/prompt-injection /opt/models/prompt-injection
COPY --from=export --chown=root:root /opt/models/harm /opt/models/harm
COPY agents/trained-detectors/detector_core.py agents/trained-detectors/server.py /app/
ENV PATH=/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DETECTOR_MODELS_DIR=/opt/models
USER 10001
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["python3", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"]
# -E -s rather than -I: -I would drop /app from sys.path and the core module with it
ENTRYPOINT ["python3", "-E", "-s", "/app/server.py"]
