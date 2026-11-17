# ADR-0362 slice 1a — the content-extraction image: the extractor (extract.py) and its pinned Python closure.
#
# It runs ONLY as an engine sandbox workload (ADR-0190 I5: gVisor, no network, read-only input, no secret): the
# gateway never parses an uploaded file itself (ADR-0362 decision 2). Slice 1b adds the task shim
# (`packages/engine-contentextract`, `node /app/dist/task-main.js`) and registers the engine; until then there is no
# manifest entry, so no runner can be admitted and nothing can enable it.
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f engines/contentextract/Dockerfile -t regulait/engine-contentextract:0.1.0 .
#
# Every base is pinned by digest. What the build does offline after the pinned download:
#   - pypdfium2 5.15.2 from OUR lockfile (requirements.txt: by sha256, `--require-hashes --no-deps --only-binary :all:`),
#     into a venv; pip is removed afterwards;
#   - the licence gate (mcpscanner's licence-gate.mjs, reused) on the INSTALLED closure and the Python runtime;
#   - the extractor's own unit tests, with REGULAIT_REQUIRE_PDFIUM=1 so the PDF cases cannot be skipped: an image whose
#     extractor fails its tests is never produced.
#
# linux/amd64 ONLY (the wheel hash is the manylinux x86_64 wheel).

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/contentextract/requirements.txt engines/contentextract/licence-allow.json engines/contentextract/licence-readings.json ./
COPY engines/mcpscanner/licence-gate.mjs ./
RUN python -m venv /opt/contentextract/venv \
 && /opt/contentextract/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/contentextract/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('pypdfium2'); sys.exit(0 if v == '5.15.2' else f'expected pypdfium2 5.15.2, got {v}')" \
 && /opt/contentextract/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && node licence-gate.mjs /opt/contentextract/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && find /opt/contentextract/venv -name '__pycache__' -prune -exec rm -rf {} +
COPY engines/contentextract/extract.py engines/contentextract/test_extract.py /opt/contentextract/
RUN REGULAIT_REQUIRE_PDFIUM=1 /opt/contentextract/venv/bin/python -I -m unittest discover -s /opt/contentextract \
 && rm /opt/contentextract/test_extract.py \
 && find /opt/contentextract -name '__pycache__' -prune -exec rm -rf {} +

# ---- stage 2: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-contentextract" \
      org.opencontainers.image.description="ADR-0362 content extraction (PDF, Office Open XML, CSV, zip), sandbox-only" \
      org.opencontainers.image.licenses="LicenseRef-RegulAIt"
RUN python -m pip uninstall -y --disable-pip-version-check pip \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin extract
COPY --from=closure /opt/contentextract /opt/contentextract
RUN chmod -R a-w /opt/contentextract
USER 10001:10001
ENTRYPOINT ["/opt/contentextract/venv/bin/python", "-I", "/opt/contentextract/extract.py"]
