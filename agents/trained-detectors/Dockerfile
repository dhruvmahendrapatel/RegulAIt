# ADR-0220 — the trained-detector service image (reference implementation of the guardrail scorer).
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f agents/trained-detectors/Dockerfile -t regulait/trained-detectors:0.1.0 .
#
# What the build does, and what the image never does:
#   - stage `weights` downloads exactly the model files and the spaCy model wheel that models.lock.json names, at
#     pinned revisions, and fails on any sha256 mismatch (fetch_models.py, standard library only). This is the ONLY
#     network the image ever needs; an air-gapped site builds once where the files are reachable (or mirrors them)
#     and moves the image.
#   - stage `closure` installs the Python closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), CPU-only torch, into a venv; pip is removed afterwards.
#   - the runtime stage carries the venv, the verified model files and the service code, runs as a non-root user,
#     and sets HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE so a model load can never reach out (every load is also
#     local_files_only).
# Size: roughly 2 GB, most of it torch and the two encoder weights (~1.2 GB together). It is not built in CI (see
# README.md); shrinking it with an ONNX runtime build is a recorded follow-up.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the pinned model files ---------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS weights
WORKDIR /build
COPY agents/trained-detectors/fetch_models.py agents/trained-detectors/models.lock.json ./
RUN python3 -I fetch_models.py models.lock.json /opt/models

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
# ADR-0184 / ADR-0200 (patch, never allow-list): CVE-2026-76844 and CVE-2026-85091 (zlib1g, HIGH).
# The pinned base digest is still the newest published one and ships 1:1.3.dfsg+really1.3.1-1+b1;
# the fix is in Debian trixie-security. Upgrade exactly that package to exactly the fixed version,
# then drop what apt and dpkg wrote with wall-clock content (the lists, their logs and ldconfig's
# aux-cache), so the layer stays byte-reproducible (ADR-0187 addendum 2026-10-21: build and rebuild
# must match). Remove this when a rebuilt base digest already carries the fix.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin detector
COPY --from=closure /venv /venv
COPY --from=weights --chown=root:root /opt/models/prompt-injection /opt/models/prompt-injection
COPY --from=weights --chown=root:root /opt/models/harm /opt/models/harm
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
