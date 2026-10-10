# ADR-0187 B5-M — the modelscan engine image. ONE image, TWO containers (decision 104):
#
#   engine-modelscan          the runner: `node /app/dist/main.js`, on the internal `engines` network,
#                             holding the runner token on its state volume; it never runs modelscan
#   engine-modelscan-scanner  the scanner: `node /app/dist/scanner-main.js`, network_mode: none, no
#                             token, no state; it runs modelscan on the read-only job volume
#
# Built from the REPOSITORY ROOT (the shim is a workspace package):
#
#   docker build -f engines/modelscan/Dockerfile -t regulait/engine-modelscan:0.8.8 .
#
# Every base is pinned by digest. What the build does offline after the pinned download:
#   - modelscan 0.8.8 and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), into a venv; pip is removed afterwards;
#     the TensorFlow extra is not installed (G19: .keras and SavedModel files are not run);
#   - the one patch (patches/format-names-from-settings.py, decision 107), which refuses to apply
#     unless it finds exactly the code it expects: without it modelscan 0.8.8 scans nothing when its
#     settings come from a file;
#   - the licence gate (licence-gate.mjs) on the INSTALLED closure, its bundled native libraries and
#     the Python runtime: anything outside the ADR-0176 list fails the build unless licence-allow.json
#     admits it, and every entry there must be a recorded owner acceptance (numpy's runtime code, ADR-0187
#     decision 106) or say "pending owner decision" (HDF5, CPython);
#   - our settings file baked read-only at /opt/modelscan/modelscan-settings.toml;
#   - the strict .npy header check (npy-header.py, stdlib only, ADR-0187 decision 180) baked
#     read-only at /opt/modelscan/npy-header.py: the scanner runs it before modelscan on every .npy.
# Signing, the image-level Trivy scan (vulnerabilities and the OS-layer licence scan) and the image
# SBOM join publish-image.yml / security.yml when the image is first built in CI (ADR-0184), as for
# promptfoo. The manifest (packages/shared/src/engines/manifest.ts) carries NO digest until an image
# has been built and its digest recorded there; until then the engine cannot be enabled.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/modelscan/requirements.txt engines/modelscan/licence-gate.mjs engines/modelscan/licence-allow.json ./
COPY engines/modelscan/patches/format-names-from-settings.py ./
RUN python -m venv /opt/modelscan/venv \
 && /opt/modelscan/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/modelscan/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('modelscan'); sys.exit(0 if v == '0.8.8' else f'expected modelscan 0.8.8, got {v}')" \
 && /opt/modelscan/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && python -I format-names-from-settings.py /opt/modelscan/venv/lib/python3.12/site-packages/modelscan/middlewares/format_via_extension.py \
 && node licence-gate.mjs /opt/modelscan/venv/lib/python3.12/site-packages licence-allow.json --runtime python=PSF-2.0 \
 && find /opt/modelscan/venv -name '__pycache__' -prune -exec rm -rf {} +
COPY engines/modelscan/modelscan-settings.toml /opt/modelscan/modelscan-settings.toml
COPY engines/modelscan/npy-header.py /opt/modelscan/npy-header.py

# ---- stage 2: the runner and scanner shim -------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-modelscan..." build \
 && pnpm --filter @regulait/engine-modelscan deploy --prod --legacy /out

# ---- stage 3: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-modelscan" \
      org.regulait.engine="modelscan" \
      org.regulait.engine-version="0.8.8" \
      org.regulait.patches="format-names-from-settings"
# no package installer at run time: the base image's pip goes too
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# PR #212 review [4235322394] (ADR-0187 decision 129): the Node binary comes from the node image, but its
# shared libraries (libstdc++.so.6, libgcc_s.so.1) must come from THIS base, as Debian packages Trivy
# sees and scans. Fail the build, here, if either package is missing, if any library node links
# against does not resolve, or if node cannot start; never at the first run.
RUN dpkg-query -W -f='${Package} ${Version}\n' libstdc++6 libgcc-s1 \
 && if ldd /usr/local/bin/node | grep -q 'not found'; then ldd /usr/local/bin/node; exit 1; fi \
 && node --version
COPY --from=closure /opt/modelscan /opt/modelscan
COPY --from=shim /out /app
# the settings are read-only for everyone; the runner's state volume is its own (0700, uid 10001),
# and the two exchange mount points exist for the volumes compose mounts on them
RUN chmod 0444 /opt/modelscan/modelscan-settings.toml /opt/modelscan/npy-header.py \
 && mkdir -p /state /work /jobs /out /results \
 && chown 10001:10001 /state /work /jobs /out /results \
 && chmod 0700 /state
# REGULAIT_EGRESS_PROBE_ADDRESS: the public literal address the egress self-test must FAIL to reach
# (ADR-0187 decision 19), in both containers
ENV NODE_ENV=production \
    HOME=/work \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_MODELSCAN_VENV=/opt/modelscan/venv \
    REGULAIT_MODELSCAN_JOBS_DIR=/jobs \
    REGULAIT_MODELSCAN_RESULTS_DIR=/results \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14
USER 10001:10001
WORKDIR /work
CMD ["node", "/app/dist/main.js"]
