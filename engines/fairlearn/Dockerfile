# ADR-0346 — the fairlearn engine image, built exactly as spikee's (engines/spikee/Dockerfile). ONE image, two uses:
#
#   engine-fairlearn  the runner: `node /app/dist/main.js`, on the internal `engines` network, holding the runner key
#                     on its state volume; it never calls a model, never runs fairlearn and never sees a dataset row
#   the task          `node /app/dist/task-main.js` (the manifest's taskEntry), started ONLY by the sandbox executor in
#                     a gVisor sandbox under the run's engine_worker placement: no network but the gateway channel, no
#                     runner key, no state; one gateway call per prompt with the run's key, then ONE metric process,
#                     `/opt/fairlearn/venv/bin/python -I -B -c <boot> <rows> /opt/fairlearn/fairlearn_metrics.py`
#
# Built from the REPOSITORY ROOT (the shim is a workspace package):
#
#   docker build -f engines/fairlearn/Dockerfile -t regulait/engine-fairlearn:0.15.0 .
#
# Every base is pinned by digest (the same node and python bases as garak's and spikee's). What the build does
# offline after the pinned download:
#   - fairlearn 0.15.0 (no extras) and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), into a venv; `pip check` must pass; the version is asserted;
#   - the licence gate (licence-gate.mjs, spikee's with the reuse form naming fairlearn and ADR-0346) on the INSTALLED
#     closure, its bundled native libraries and the Python runtime: anything outside the ADR-0176 list fails the build
#     unless licence-allow.json admits it; licence-readings.json records scipy's licence, read from its wheel's own
#     licence file and pinned by sha256 (its METADATA carries the full text, not an SPDX expression);
#   - our metric step (fairlearn_metrics.py) at /opt/fairlearn/, read-only and root-owned, proven offline
#     (`--network=none`) on a small embedded job whose four values are asserted exactly.
# Nothing is downloaded at run time: fairlearn and its closure have no update check or telemetry, and the task sandbox
# has no route out but the gateway channel. Signing, the image-level Trivy scan and the image SBOM run in
# security.yml. The manifest carries NO digest until an image has been built and published; until then the engine
# cannot be enabled.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the Python closure ----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/fairlearn/requirements.txt engines/fairlearn/licence-gate.mjs engines/fairlearn/licence-allow.json engines/fairlearn/licence-readings.json engines/fairlearn/fairlearn_metrics.py ./
RUN python -m venv /opt/fairlearn/venv \
 && /opt/fairlearn/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/fairlearn/venv/bin/pip check --disable-pip-version-check \
 && /opt/fairlearn/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('fairlearn'); sys.exit(0 if v == '0.15.0' else f'expected fairlearn 0.15.0, got {v}')" \
 && /opt/fairlearn/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && node licence-gate.mjs /opt/fairlearn/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && find /opt/fairlearn/venv -name '__pycache__' -prune -exec rm -rf {} + \
 && install -m 0444 fairlearn_metrics.py /opt/fairlearn/fairlearn_metrics.py
# the offline proof: no network at all, only PATH and the usage-data switches, the metric step exactly as the task
# starts it (config.ts: the boot line opens the rows file as the script's stdin) on a four-row job whose values are
# known (selection rates 0.5 / 0, true-positive rates 1 / 0, false-positive rates 0 / 0)
RUN --network=none cd "$(mktemp -d)" \
 && printf '%s' '{"labels":[1,0,1,0],"predictions":[1,0,0,0],"attributes":{"g":["a","a","b","b"]}}' > rows.json \
 && env -i PATH=/opt/fairlearn/venv/bin:/usr/local/bin:/usr/bin:/bin OTEL_SDK_DISABLED=true DO_NOT_TRACK=1 PYTHONDONTWRITEBYTECODE=1 \
      /opt/fairlearn/venv/bin/python -I -B -c "import runpy, sys; sys.stdin = open(sys.argv[1], encoding='utf-8'); sys.argv = [sys.argv[2]]; runpy.run_path(sys.argv[0], run_name='__main__')" rows.json /opt/fairlearn/fairlearn_metrics.py > out.json \
 && /opt/fairlearn/venv/bin/python -I -B -c "import json, sys; got = json.load(open('out.json')); want = {'fairlearn': '0.15.0', 'attributes': {'g': {'demographic_parity_difference': 0.5, 'disparate_impact_ratio': 0.0, 'equal_opportunity_difference': 1.0, 'equalized_odds_difference': 1.0}}}; sys.exit(0 if got == want else f'offline proof: got {got}')"

# ---- stage 2: the runner and worker shim --------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# reproducible builds (ADR-0187 addendum 2026-10-21): the normaliser sorts .modules.yaml and takes the time from SOURCE_DATE_EPOCH
COPY scripts/engine-images-normalise.mjs ./scripts/engine-images-normalise.mjs
ARG SOURCE_DATE_EPOCH
RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-fairlearn..." build \
 && pnpm --filter @regulait/engine-fairlearn deploy --prod --legacy /out \
 && node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml

# ---- stage 3: runtime ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-fairlearn" \
      org.regulait.engine="fairlearn" \
      org.regulait.engine-version="0.15.0"
# ADR-0184 / ADR-0200 (patch, never allow-list): CVE-2026-76844 and CVE-2026-85091 (zlib1g, HIGH), the same layer
# as the other engine images (#735). The pinned base digest ships 1:1.3.dfsg+really1.3.1-1+b1; the fix is in Debian
# trixie-security. Upgrade exactly that package to exactly the fixed version, then drop what apt and dpkg wrote with
# wall-clock content, so the layer stays byte-reproducible. Remove this when a rebuilt base digest carries the fix.
# CVE-2026-124851 (libzstd1, HIGH, 2026-11-25): the same treatment. Neither the pinned base digest nor the
# newest published one ships the fix; trixie-security has 1.5.7+dfsg-1+deb13u1. Remove with the zlib1g pin.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 libzstd1=1.5.7+dfsg-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
# no package installer at run time: the base image's pip goes too
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=closure /opt/fairlearn /opt/fairlearn
# the venv and the metric step are root-owned and read-only for everyone
RUN chown -R 0:0 /opt/fairlearn && chmod -R a-w,a+rX /opt/fairlearn/venv/lib/python3.12/site-packages /opt/fairlearn/fairlearn_metrics.py
COPY --from=shim /out /app
# the runner's state volume is its own (0700, uid 10001); the exchange mount points exist for the volumes compose
# mounts on them
RUN mkdir -p /state /work /jobs /out /results \
 && chown 10001:10001 /state /work /jobs /out /results \
 && chmod 0700 /state
# Every usage-data switch the worker's self-test checks (FAIRLEARN_USAGE_DATA_ENV), and the public literal address the
# egress self-test must FAIL to reach (ADR-0187 decision 19). The task also builds the metric process's environment
# from nothing with these values (config.ts).
ENV NODE_ENV=production \
    HOME=/work \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    OTEL_SDK_DISABLED=true \
    DO_NOT_TRACK=1 \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_FAIRLEARN_VENV=/opt/fairlearn/venv \
    REGULAIT_FAIRLEARN_JOBS_DIR=/jobs \
    REGULAIT_FAIRLEARN_RESULTS_DIR=/results \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14
USER 10001:10001
WORKDIR /work
CMD ["node", "/app/dist/main.js"]
