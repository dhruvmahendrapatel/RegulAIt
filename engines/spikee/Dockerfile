# ADR-0245 — the spikee engine image, built exactly as garak's (engines/garak/Dockerfile). ONE image, two uses:
#
#   engine-spikee  the runner: `node /app/dist/main.js`, on the internal `engines` network, holding the runner key on
#                  its state volume; it never runs spikee
#   the task       `node /app/dist/task-main.js` (the manifest's taskEntry), started ONLY by the sandbox executor in a
#                  gVisor sandbox under the run's engine_worker placement: no network but the gateway channel, no
#                  runner key, no state; two spikee processes per dataset (generate, test) with the run's key
#
# Built from the REPOSITORY ROOT (the shim is a workspace package):
#
#   docker build -f engines/spikee/Dockerfile -t regulait/engine-spikee:0.9.4 .
#
# Every base is pinned by digest (the same node and python bases as garak's). What the build does offline after the
# pinned download:
#   - spikee 0.9.4 (no extras) and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), into a venv; `pip check` must pass; the version is asserted;
#   - prune-data.py checks the local seed folders are the files the shared catalogue was read from
#     (SPIKEE_LOCAL_SEEDS_SHA256) and removes what the catalogue excludes (excluded-data.txt: the Hub fetch scripts and
#     the workspace LLM judges; a listed path that is missing fails the build);
#   - the licence gate (licence-gate.mjs, garak's with one added decision form) on the INSTALLED closure, its bundled
#     native libraries and the Python runtime: anything outside the ADR-0176 list fails the build unless
#     licence-allow.json admits it; licence-readings.json records licences read from a wheel's own licence file,
#     pinned by sha256;
#   - the seed folders are linked at /opt/spikee/seeds (read-only, root-owned), the path the worker passes to
#     `spikee generate --seed-folder`.
# Nothing is downloaded at run time: spikee has no update check or telemetry, the Hub libraries are switched offline,
# and the task sandbox has no route out but the gateway channel. Signing, the image-level Trivy scan and the image
# SBOM run in security.yml. The manifest carries NO digest until an image has been built and published; until then the
# engine cannot be enabled.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/spikee/requirements.txt engines/spikee/licence-gate.mjs engines/spikee/licence-allow.json engines/spikee/licence-readings.json engines/spikee/excluded-data.txt engines/spikee/prune-data.py ./
RUN python -m venv /opt/spikee/venv \
 && /opt/spikee/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/spikee/venv/bin/pip check --disable-pip-version-check \
 && /opt/spikee/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('spikee'); sys.exit(0 if v == '0.9.4' else f'expected spikee 0.9.4, got {v}')" \
 && /opt/spikee/venv/bin/python -I prune-data.py /opt/spikee/venv/lib/python3.12/site-packages excluded-data.txt 99d04872d9f3b6ac6c49a29129f23afc753afe594551ea6183850b4799062567 \
 && /opt/spikee/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && node licence-gate.mjs /opt/spikee/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && find /opt/spikee/venv -name '__pycache__' -prune -exec rm -rf {} + \
 && ln -s /opt/spikee/venv/lib/python3.12/site-packages/spikee/data/workspace/datasets /opt/spikee/seeds
# the offline proof: no network at all, every offline switch set, spikee's CLI loads and generates a local dataset
RUN --network=none cd "$(mktemp -d)" && PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 OTEL_SDK_DISABLED=true DO_NOT_TRACK=1 \
    /opt/spikee/venv/bin/python -I -B -c "import sys; from spikee.cli import main; sys.argv[0] = 'spikee'; main()" -q generate --seed-folder /opt/spikee/seeds/seeds-mini-test --format full-prompt --threads 1 --plugins base64 > /dev/null \
 && test "$(ls datasets/*.jsonl | wc -l)" = 1

# ---- stage 2: the runner and worker shim --------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# reproducible builds (ADR-0187 addendum 2026-10-21): the normaliser sorts .modules.yaml and takes the time from SOURCE_DATE_EPOCH
COPY scripts/engine-images-normalise.mjs ./scripts/engine-images-normalise.mjs
ARG SOURCE_DATE_EPOCH
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-spikee..." build \
 && pnpm --filter @regulait/engine-spikee deploy --prod --legacy /out \
 && node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml

# ---- stage 3: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-spikee" \
      org.regulait.engine="spikee" \
      org.regulait.engine-version="0.9.4" \
      org.regulait.data-pruned="excluded-data.txt"
# no package installer at run time: the base image's pip goes too
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=closure /opt/spikee /opt/spikee
# the installed package (and so the seed folders) is root-owned and read-only for everyone
RUN chown -R 0:0 /opt/spikee && chmod -R a-w,a+rX /opt/spikee/venv/lib/python3.12/site-packages/spikee
COPY --from=shim /out /app
# the runner's state volume is its own (0700, uid 10001); the exchange mount points exist for the volumes compose
# mounts on them
RUN mkdir -p /state /work /jobs /out /results \
 && chown 10001:10001 /state /work /jobs /out /results \
 && chmod 0700 /state
# Every usage-data switch the worker's self-test checks (SPIKEE_USAGE_DATA_ENV), and the public literal address the
# egress self-test must FAIL to reach (ADR-0187 decision 19). The worker also builds each spikee process's environment
# from nothing with these values (config.ts).
ENV NODE_ENV=production \
    HOME=/work \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    HF_HUB_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    OTEL_SDK_DISABLED=true \
    DO_NOT_TRACK=1 \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_SPIKEE_VENV=/opt/spikee/venv \
    REGULAIT_SPIKEE_JOBS_DIR=/jobs \
    REGULAIT_SPIKEE_RESULTS_DIR=/results \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14
USER 10001:10001
WORKDIR /work
CMD ["node", "/app/dist/main.js"]
