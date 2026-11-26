# ADR-0242 — the mcpscanner engine image: Cisco mcp-scanner 4.8.7 in its offline STATIC mode, run by our
# driver (scan.py) on an MCP manifest the gateway hands it. ONE image, two uses (ADR-0242 §6.1, as modelscan's):
#
#   the runner  `node /app/dist/main.js` (packages/engine-admission-scan), on the internal `engines` network,
#               holding the runner key on its state volume; it never runs the scanner
#   the task    `node /app/dist/task-main.js mcpscanner` (the manifest's taskEntry), started ONLY by the sandbox
#               executor in a gVisor sandbox under the run's engine_worker placement: no network, no token, no
#               state; it runs `python -I /opt/mcpscanner/scan.py <input root> <report>` on the gateway's tools.json
#
# Until an image is published and recorded in engines/images.lock.json (§6.3) the engine carries no digest and
# cannot be enabled.
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f engines/mcpscanner/Dockerfile -t regulait/engine-mcpscanner:4.8.7 .
#
# Every base is pinned by digest. What the build does offline after the pinned downloads:
#   - yara-python 4.5.4 is built from its hashed sdist (requirements-sdist.txt) with NO OpenSSL: its wheel
#     bundles OpenSSL 1.1.1w (end of life), and mcp-scanner's rules import no YARA module that needs it
#     (no `hash`, `pe` or `magic`). The build fails if the built module links libcrypto;
#   - mcp-scanner 4.8.7 and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), into a venv; pip and setuptools are removed;
#   - the licence gate (licence-gate.mjs) on the INSTALLED closure: anything outside the ADR-0176 list fails
#     the build unless licence-allow.json records an owner acceptance or "pending owner decision";
#   - the YARA rules mcp-scanner ships are copied read-only to /opt/mcpscanner/yara_rules and their digest
#     must equal yara-rules.sha256 (committed): a rules change is a reviewed change, never a silent one;
#   - an offline smoke scan of a known-bad and a clean manifest, with no network, must flag and pass.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: yara-python from source, without OpenSSL ----------------------------------------------------
FROM --platform=linux/amd64 python:3.12-trixie@sha256:cad37dd20c7cac861af9003af8796d03ea7a998ec1e3a664429740fc9d7d2691 AS yara
WORKDIR /build
COPY engines/mcpscanner/requirements-build.txt engines/mcpscanner/requirements-sdist.txt ./
# the headers go first, so setup.py's OpenSSL probe fails and the HASH module is not compiled in. The sdist (sha256
# checked by --require-hashes) is built in a FIXED directory, without debug info and with that directory mapped away:
# pip's own build dir is random, and the .so carried its path, so two builds differed (engine-images-build repro).
# SOURCE_DATE_EPOCH (1980-01-01, the zip format's floor) fixes the wheel's zip timestamps: pip records the wheel's
# hash in direct_url.json and RECORD, so a wheel built at another second changed the installed files.
RUN rm -rf /usr/include/openssl /usr/include/x86_64-linux-gnu/openssl \
 && python -m venv /opt/build \
 && /opt/build/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements-build.txt \
 && /opt/build/bin/pip download --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --no-build-isolation --no-binary :all: -d /sdist -r requirements-sdist.txt \
 && mkdir /build/src && tar -xzf /sdist/yara_python-4.5.4.tar.gz -C /build/src \
 && cd /build/src/yara_python-4.5.4 \
 && SOURCE_DATE_EPOCH=315532800 CFLAGS="-g0 -ffile-prefix-map=/build/src/yara_python-4.5.4=." \
    /opt/build/bin/pip wheel --no-cache-dir --disable-pip-version-check --no-deps --no-build-isolation -w /wheels . \
 && ls /wheels/yara_python-4.5.4-cp312-cp312-linux_x86_64.whl

# ---- stage 2: the Python closure ----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=yara /wheels /wheels
WORKDIR /build
COPY engines/mcpscanner/requirements.txt engines/mcpscanner/licence-gate.mjs engines/mcpscanner/licence-allow.json engines/mcpscanner/licence-readings.json engines/mcpscanner/yara-rules.sha256 ./
COPY engines/mcpscanner/scan.py /opt/mcpscanner/scan.py
RUN python -m venv /opt/mcpscanner/venv \
 && /opt/mcpscanner/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/mcpscanner/venv/bin/pip install --no-cache-dir --disable-pip-version-check --no-deps --no-index /wheels/yara_python-4.5.4-cp312-cp312-linux_x86_64.whl \
 && /opt/mcpscanner/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('cisco-ai-mcp-scanner'); sys.exit(0 if v == '4.8.7' else f'expected mcp-scanner 4.8.7, got {v}')" \
 && /opt/mcpscanner/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && SO=$(/opt/mcpscanner/venv/bin/python -I -c "import yara; print(yara.__file__)") \
 && if ldd "$SO" | grep -q libcrypto; then echo "yara-python links libcrypto" >&2; exit 1; fi \
 && node licence-gate.mjs /opt/mcpscanner/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && cp -r /opt/mcpscanner/venv/lib/python3.12/site-packages/mcpscanner/data/yara_rules /opt/mcpscanner/yara_rules \
 && cp yara-rules.sha256 /opt/mcpscanner/yara-rules.sha256 \
 && find /opt/mcpscanner/venv -name '__pycache__' -prune -exec rm -rf {} +

# ---- the runner and task shim (ADR-0242 §6.1, as engines/modelscan/Dockerfile's) -----------------------------------
# packages/engine-admission-scan, one package for both admission-scan images: `node /app/dist/main.js` is the runner
# (on the internal `engines` network, holding the runner key; it never runs the scanner) and
# `node /app/dist/task-main.js mcpscanner` is the manifest's taskEntry, started ONLY by the sandbox executor in a gVisor
# sandbox under the run's engine_worker placement, where it runs our driver on the gateway's subject file.
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
RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-admission-scan..." build \
 && pnpm --filter @regulait/engine-admission-scan deploy --prod --legacy /out \
 && node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml

# ---- stage 3: runtime ---------------------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-mcpscanner" \
      org.regulait.engine="mcpscanner" \
      org.regulait.engine-version="4.8.7" \
      org.regulait.analyzers="yara,schema"
# no package installer at run time: the base image's pip goes too
# ADR-0184 / ADR-0200 (patch, never allow-list): CVE-2026-76844 and CVE-2026-85091 (zlib1g, HIGH), as #735 did
# for the other engine images. The pinned base digest is still the newest published one and ships
# 1:1.3.dfsg+really1.3.1-1+b1; the fix is in Debian trixie-security. Upgrade exactly that package to exactly the
# fixed version, then drop what apt and dpkg wrote with wall-clock content, so the layer stays byte-reproducible.
# Remove this when a rebuilt base digest already carries the fix.
# CVE-2026-124851 (libzstd1, HIGH, 2026-11-25): the same treatment. Neither the pinned base digest nor the
# newest published one ships the fix; trixie-security has 1.5.7+dfsg-1+deb13u1. Remove with the zlib1g pin.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 libzstd1=1.5.7+dfsg-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
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
COPY --from=closure /opt/mcpscanner /opt/mcpscanner
COPY --from=shim /out /app
COPY engines/mcpscanner/fixtures /opt/mcpscanner/fixtures
RUN chmod -R a-w /opt/mcpscanner \
 && mkdir -p /work /in /out && chown 10001:10001 /work /in /out
# the runner's state volume is its own (0700, uid 10001); the bridge's exchange directories are the runner's too
RUN mkdir -p /state /jobs /results \
 && chown 10001:10001 /state /jobs /results \
 && chmod 0700 /state
# LITELLM_LOCAL_MODEL_COST_MAP: litellm (imported by mcpscanner's package root) otherwise fetches a remote price
# map at import time (measured: six connect() calls without it, none with it). The driver sets it again and
# refuses to run with any cloud analyzer credential in its environment.
# REGULAIT_ADMISSION_ENGINE: which engine the runner serves (the task takes it from the manifest's argv).
# REGULAIT_EGRESS_PROBE_ADDRESS: the public literal address the runner's egress self-test must FAIL to reach
# (ADR-0187 decision 19); the task probes ENGINE_TASK_EGRESS_PROBE_ADDRESS itself (the sandbox init passes no env).
ENV NODE_ENV=production \
    HOME=/work \
    LANG=C.UTF-8 \
    REGULAIT_ADMISSION_ENGINE=mcpscanner \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_ADMISSION_JOBS_DIR=/jobs \
    REGULAIT_ADMISSION_RESULTS_DIR=/results \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    LITELLM_TELEMETRY=False \
    HF_HUB_OFFLINE=1 \
    REGULAIT_MCPSCANNER_RULES_DIR=/opt/mcpscanner/yara_rules \
    REGULAIT_MCPSCANNER_RULES_MANIFEST=/opt/mcpscanner/yara-rules.sha256
USER 10001:10001
WORKDIR /work
# the smoke scan: the known-bad manifest must be flagged and the clean one must pass, offline, in the image as built
RUN --network=none /opt/mcpscanner/venv/bin/python -I /opt/mcpscanner/scan.py /opt/mcpscanner/fixtures/bad /work/bad.json \
 && /opt/mcpscanner/venv/bin/python -I -c "import json,sys; r=json.load(open('/work/bad.json')); sys.exit(0 if r['status']=='completed' and any(f['severity'] in ('high','critical') for f in r['findings']) else 'bad fixture not flagged')" \
 && /opt/mcpscanner/venv/bin/python -I /opt/mcpscanner/scan.py /opt/mcpscanner/fixtures/clean /work/clean.json \
 && /opt/mcpscanner/venv/bin/python -I -c "import json,sys; r=json.load(open('/work/clean.json')); sys.exit(0 if r['status']=='completed' and not r['findings'] else 'clean fixture flagged')" \
 && rm -f /work/bad.json /work/clean.json \
 && leftover="$(ls -A /work /tmp | grep -v -e '^/' -e '^$' || true)" \
 && { [ -z "$leftover" ] || { echo "the smoke scan left files in the image (they would make it unreproducible): $leftover" >&2; exit 1; }; }
# the runner; the task (`node /app/dist/task-main.js <engine>`) is started only by the sandbox executor
CMD ["node", "/app/dist/main.js"]
