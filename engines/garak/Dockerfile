# ADR-0187 B5-G — the garak engine image. ONE image, two uses (ADR-0190 I5):
#
#   engine-garak  the runner: `node /app/dist/main.js`, on the internal `engines` network, holding the
#                 runner key on its state volume; it never runs garak
#   the task      `node /app/dist/task-main.js` (the manifest's taskEntry), started ONLY by the sandbox
#                 executor in a gVisor sandbox under the run's engine_worker placement: no network but the
#                 gateway channel, no runner key, no state; one garak process per probe with the run's key
#
# Built from the REPOSITORY ROOT (the shim is a workspace package):
#
#   docker build -f engines/garak/Dockerfile -t regulait/engine-garak:0.17.1 .
#
# Every base is pinned by digest. What the build does offline after the pinned download:
#   - garak 0.17.1 and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
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
#   - the licence-clear Hugging Face assets R10 names are PRE-SEEDED (owner 2026-10-10, open question 22;
#     ADR-0187 decisions 198-200) by preseed-hf.py in their own stage: every file at a pinned commit and
#     sha256 (hf-preseed.json), each licence read from the card at that commit, `refs/main` set to it,
#     the datasets materialised; then a `--network=none` step loads every asset offline in the worker's
#     layout, or the build fails. The tree is root-owned and read-only at run time; nothing is
#     downloaded at run time, and the probes that need anything else are never planned (the manifest's
#     reduced set);
#   - IMAGE-NOTICES.txt (the data notices: the Unicode and CC-BY-4.0 attributions, the OpenRAIL use
#     restrictions) is shipped at /opt/garak/NOTICES.txt (decision 197).
# Signing, the image-level Trivy scan and the image SBOM run in security.yml (decision 120). The
# manifest (packages/shared/src/engines/manifest.ts) carries NO digest until an image has been built
# and published; until then the engine cannot be enabled.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/garak/requirements.txt engines/garak/requirements-sdist.txt engines/garak/licence-gate.mjs engines/garak/licence-allow.json engines/garak/licence-readings.json engines/garak/excluded-data.txt engines/garak/prune-data.py ./
RUN python -m venv /opt/garak/venv \
 && /opt/garak/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/garak/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --no-build-isolation --no-binary :all: -r requirements-sdist.txt \
 && /opt/garak/venv/bin/pip check --disable-pip-version-check \
 && /opt/garak/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('garak'); sys.exit(0 if v == '0.17.1' else f'expected garak 0.17.1, got {v}')" \
 && /opt/garak/venv/bin/python -I prune-data.py /opt/garak/venv/lib/python3.12/site-packages excluded-data.txt 6ba9cca2c36f8045463911783cb4869ae69da6c514d81330a27e29b0de230209 \
 && /opt/garak/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && node licence-gate.mjs /opt/garak/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && find /opt/garak/venv -name '__pycache__' -prune -exec rm -rf {} +

# ---- stage 1b: the pre-seeded Hugging Face assets (the ONE step with network beyond the pinned downloads)
FROM closure AS preseed
COPY engines/garak/hf-preseed.json engines/garak/preseed-hf.py ./
RUN PYTHONDONTWRITEBYTECODE=1 /opt/garak/venv/bin/python -I preseed-hf.py fetch hf-preseed.json /opt/garak/hf \
 && PYTHONDONTWRITEBYTECODE=1 /opt/garak/venv/bin/python -I preseed-hf.py materialise hf-preseed.json /opt/garak/hf
# the offline proof: no network at all, every offline switch set, the worker's per-probe layout
RUN --network=none PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    /opt/garak/venv/bin/python -I preseed-hf.py verify hf-preseed.json /opt/garak/hf

# ---- stage 2: the runner and worker shim --------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS shim
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
 && pnpm --filter "@regulait/engine-garak..." build \
 && pnpm --filter @regulait/engine-garak deploy --prod --legacy /out \
 && node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml

# ---- stage 3: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-garak" \
      org.regulait.engine="garak" \
      org.regulait.engine-version="0.17.1" \
      org.regulait.data-pruned="excluded-data.txt"
# no package installer at run time: the base image's pip goes too
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=closure /opt/garak /opt/garak
COPY --from=preseed /opt/garak/hf /opt/garak/hf
COPY engines/garak/IMAGE-NOTICES.txt /opt/garak/NOTICES.txt
# the pre-seeded tree is read-only for everyone (the worker reads it; nothing may override it)
RUN chown -R 0:0 /opt/garak/hf /opt/garak/NOTICES.txt && chmod -R a-w,a+rX /opt/garak/hf /opt/garak/NOTICES.txt
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
