# ADR-0362 — the content-extraction engine image: our extractor (extract.py) and its pinned Python closure, plus the
# runner and task shim it shares with the admission-scan images (ADR-0242 §6.1). ONE image, two uses:
#
#   the runner  `node /app/dist/main.js` (packages/engine-admission-scan), on the internal `engines` network,
#               holding the runner key on its state volume; it never runs the extractor
#   the task    `node /app/dist/task-main.js contentextract` (the manifest's taskEntry), started ONLY by the sandbox
#               executor in a gVisor sandbox under the run's engine_worker placement (ADR-0190 I5): no network, no
#               token, no state; it runs `python -I /opt/contentextract/extract.py <input>/bundle.json <report>` on the
#               bundle the gateway itself placed. The gateway never parses an uploaded file (ADR-0362 decision 2).
#
# Until an image is published and recorded in engines/images.lock.json the engine carries no digest and cannot be
# enabled.
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f engines/contentextract/Dockerfile -t regulait/engine-contentextract:0.1.0 .
#
# Every base is pinned by digest. What the build does offline after the pinned downloads:
#   - pypdfium2 5.15.2 from OUR lockfile (requirements.txt: by sha256, `--require-hashes --no-deps --only-binary :all:`),
#     into a venv; pip is removed afterwards;
#   - the licence gate (licence-gate.mjs, this engine's copy of mcpscanner's) on the INSTALLED closure and the Python
#     runtime;
#   - Tesseract 5.5.0 and its eng/osd language data from Debian trixie, exact versions (ADR-0362 slice 2), in the test
#     stage and the runtime;
#   - the extractor's own unit tests, with REGULAIT_REQUIRE_PDFIUM=1 and REGULAIT_REQUIRE_OCR=1 so the PDF and OCR cases
#     cannot be skipped: an image whose extractor fails its tests is never produced;
#   - the shim (packages/engine-admission-scan) built and deployed in a pinned node stage, exactly as modelscan's.
#
# linux/amd64 ONLY (the wheel hash is the manylinux x86_64 wheel).

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/contentextract/requirements.txt engines/contentextract/licence-gate.mjs engines/contentextract/licence-allow.json engines/contentextract/licence-readings.json ./
RUN python -m venv /opt/contentextract/venv \
 && /opt/contentextract/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/contentextract/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('pypdfium2'); sys.exit(0 if v == '5.15.2' else f'expected pypdfium2 5.15.2, got {v}')" \
 && /opt/contentextract/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && node licence-gate.mjs /opt/contentextract/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && find /opt/contentextract/venv -name '__pycache__' -prune -exec rm -rf {} +
# ADR-0362 slice 2: Tesseract OCR (Apache-2.0) and its English language data, from Debian trixie, exact versions.
# Everything OCR needs is in the image, so nothing is downloaded at run time (air-gapped).
# Reproducible builds (ADR-0187 addendum 2026-10-21): the packages' maintainer scripts write wall-clock content
# (update-alternatives' log, apt's binary caches, fontconfig's cache), which goes, as in robot-runner's image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr=5.5.0-1+b1 tesseract-ocr-eng=1:4.1.0-2 tesseract-ocr-osd=1:4.1.0-2 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache \
           /var/cache/apt/*.bin /var/cache/fontconfig/* \
 && tesseract --version
COPY engines/contentextract/extract.py engines/contentextract/test_extract.py /opt/contentextract/
RUN REGULAIT_REQUIRE_PDFIUM=1 REGULAIT_REQUIRE_OCR=1 /opt/contentextract/venv/bin/python -I -m unittest discover -s /opt/contentextract \
 && rm /opt/contentextract/test_extract.py \
 && find /opt/contentextract -name '__pycache__' -prune -exec rm -rf {} +

# ---- the runner and task shim (ADR-0242 §6.1, as engines/modelscan/Dockerfile's) -----------------------------------
# packages/engine-admission-scan, the one shim of every subject-engine image: `node /app/dist/main.js` is the runner
# (on the internal `engines` network, holding the runner key; it never runs the extractor) and
# `node /app/dist/task-main.js contentextract` is the manifest's taskEntry, started ONLY by the sandbox executor in a
# gVisor sandbox under the run's engine_worker placement, where it runs the extractor on the gateway's bundle.
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# reproducible builds (ADR-0187 addendum 2026-10-21): pnpm records the install time and the order the concurrent
# install finished in /out/node_modules/.modules.yaml; the normaliser sorts it and takes the time from SOURCE_DATE_EPOCH
COPY scripts/engine-images-normalise.mjs ./scripts/engine-images-normalise.mjs
ARG SOURCE_DATE_EPOCH
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-admission-scan..." build \
 && pnpm --filter @regulait/engine-admission-scan deploy --prod --legacy /out \
 && node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml

# ---- stage 3: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-contentextract" \
      org.opencontainers.image.description="ADR-0362 content extraction (PDF, Office Open XML, CSV, zip, OCR), sandbox-only" \
      org.opencontainers.image.licenses="LicenseRef-RegulAIt" \
      org.regulait.engine="contentextract" \
      org.regulait.engine-version="0.1.0"
# ADR-0184 / ADR-0200 (patch, never allow-list): CVE-2026-76844 and CVE-2026-85091 (zlib1g, HIGH), as the
# mcpscanner image does on this same base digest. Upgrade exactly that package to exactly the fixed version, then
# drop what apt and dpkg wrote with wall-clock content, so the layer stays byte-reproducible. Remove this when a
# rebuilt base digest already carries the fix.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
# ADR-0362 slice 2: Tesseract OCR (Apache-2.0) and its English language data, from Debian trixie, exact versions.
# Everything OCR needs is in the image, so nothing is downloaded at run time (air-gapped).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr=5.5.0-1+b1 tesseract-ocr-eng=1:4.1.0-2 tesseract-ocr-osd=1:4.1.0-2 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache \
           /var/cache/apt/*.bin /var/cache/fontconfig/* \
 && tesseract --version
# no package installer at run time: the base image's pip goes too
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# PR #212 review [4235322394] (ADR-0187 decision 129), as modelscan's: the Node binary comes from the node image, but
# its shared libraries (libstdc++.so.6, libgcc_s.so.1) must come from THIS base, as Debian packages Trivy sees and
# scans. Fail the build, here, if either package is missing, if any library node links against does not resolve, or
# if node cannot start; never at the first run.
RUN dpkg-query -W -f='${Package} ${Version}\n' libstdc++6 libgcc-s1 \
 && if ldd /usr/local/bin/node | grep -q 'not found'; then ldd /usr/local/bin/node; exit 1; fi \
 && node --version
COPY --from=closure /opt/contentextract /opt/contentextract
COPY --from=shim /out /app
RUN chmod -R a-w /opt/contentextract \
 && mkdir -p /work /in /out && chown 10001:10001 /work /in /out
# the runner's state volume is its own (0700, uid 10001); the bridge's exchange directories are the runner's too
RUN mkdir -p /state /jobs /results \
 && chown 10001:10001 /state /jobs /results \
 && chmod 0700 /state
# REGULAIT_ADMISSION_ENGINE: which engine the runner serves (the task takes it from the manifest's argv).
# REGULAIT_EGRESS_PROBE_ADDRESS: the public literal address the runner's egress self-test must FAIL to reach
# (ADR-0187 decision 19); the task probes ENGINE_TASK_EGRESS_PROBE_ADDRESS itself (the sandbox init passes no env).
ENV NODE_ENV=production \
    HOME=/work \
    LANG=C.UTF-8 \
    REGULAIT_ADMISSION_ENGINE=contentextract \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_ADMISSION_JOBS_DIR=/jobs \
    REGULAIT_ADMISSION_RESULTS_DIR=/results \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1
USER 10001:10001
WORKDIR /work
# the runner; the task (`node /app/dist/task-main.js contentextract`) is started only by the sandbox executor
CMD ["node", "/app/dist/main.js"]
