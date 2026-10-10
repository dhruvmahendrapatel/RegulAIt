# ADR-0187 B5-G — the garak engine image. ONE image, TWO containers (decision 140):
#
#   engine-garak         the runner: `node /app/dist/main.js`, on the internal `engines` network, holding
#                        the runner token on its state volume; it never runs garak
#   engine-garak-worker  the worker: `node /app/dist/worker-main.js`, on `engines` (it must reach the
#                        gateway's model routes), with NO runner token and no state; it runs one garak
#                        process per probe with the run's own virtual key
#
# Built from the REPOSITORY ROOT (the shim is a workspace package):
#
#   docker build -f engines/garak/Dockerfile -t regulait/engine-garak:0.17.0 .
#
# Every base is pinned by digest. What the build does offline after the pinned download:
#   - garak 0.17.0 and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), into a venv; torch is the CPU-only wheel by
#     direct URL (the default resolution pulls proprietary CUDA runtime packages, R10); the two
#     packages with no Python 3 wheel (requirements-sdist.txt) are built from their hashed sdists with
#     the pinned setuptools and no build isolation (no unhashed build dependency); `pip check` must pass;
#   - prune-data.py removes the data G19 excludes (excluded-data.txt; a listed path that is missing
#     fails the build) and checks plugin_cache.json is the file the shared catalogue was generated from;
#   - the licence gate (licence-gate.mjs) on the INSTALLED closure, its bundled native libraries and the
#     Python runtime: anything outside the ADR-0176 list fails the build unless licence-allow.json admits
#     it, and every entry there is a recorded owner acceptance or says "pending owner decision";
#     licence-readings.json records licences read from a wheel's own licence file, pinned by sha256;
#   - nothing is downloaded at run time: no Hugging Face model or dataset is pre-seeded, and the probes
#     that need one are never planned (the manifest's reduced set).
# Signing, the image-level Trivy scan and the image SBOM run in security.yml (decision 120). The
# manifest (packages/shared/src/engines/manifest.ts) carries NO digest until an image has been built
# and published; until then the engine cannot be enabled.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/garak/requirements.txt engines/garak/requirements-sdist.txt engines/garak/licence-gate.mjs engines/garak/licence-allow.json engines/garak/licence-readings.json engines/garak/excluded-data.txt engines/garak/prune-data.py ./
RUN python -m venv /opt/garak/venv \
 && /opt/garak/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/garak/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --no-build-isolation --no-binary :all: -r requirements-sdist.txt \
 && /opt/garak/venv/bin/pip check --disable-pip-version-check \
 && /opt/garak/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('garak'); sys.exit(0 if v == '0.17.0' else f'expected garak 0.17.0, got {v}')" \
 && /opt/garak/venv/bin/python -I prune-data.py /opt/garak/venv/lib/python3.12/site-packages excluded-data.txt 25484e2467c84b1a59e27ae7ebf433a305b00c859aa1904c315f916661134a52 \
 && /opt/garak/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && node licence-gate.mjs /opt/garak/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && find /opt/garak/venv -name '__pycache__' -prune -exec rm -rf {} +

# ---- stage 2: the runner and worker shim --------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-garak..." build \
 && pnpm --filter @regulait/engine-garak deploy --prod --legacy /out

# ---- stage 3: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-garak" \
      org.regulait.engine="garak" \
      org.regulait.engine-version="0.17.0" \
      org.regulait.data-pruned="excluded-data.txt"
# no package installer at run time: the base image's pip goes too
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=closure /opt/garak /opt/garak
COPY --from=shim /out /app
# the runner's state volume is its own (0700, uid 10001); the exchange mount points exist for the
# volumes compose mounts on them
RUN mkdir -p /state /work /jobs /out /results \
 && chown 10001:10001 /state /work /jobs /out /results \
 && chmod 0700 /state
# Every usage-data switch the worker's self-test checks (GARAK_USAGE_DATA_ENV), and the public literal
# address the egress self-test must FAIL to reach (ADR-0187 decision 19), in both containers. The worker
# also builds each garak process's environment from nothing with these values (config.ts).
ENV NODE_ENV=production \
    HOME=/work \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    OTEL_SDK_DISABLED=true \
    LANGSMITH_TRACING=false \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_GARAK_VENV=/opt/garak/venv \
    REGULAIT_GARAK_JOBS_DIR=/jobs \
    REGULAIT_GARAK_RESULTS_DIR=/results \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14
USER 10001:10001
WORKDIR /work
CMD ["node", "/app/dist/main.js"]
