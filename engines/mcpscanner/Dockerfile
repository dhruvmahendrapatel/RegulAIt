# ADR-0242 — the mcpscanner engine image: Cisco mcp-scanner 4.8.7 in its offline STATIC mode, run by our
# driver (scan.py) on an MCP manifest the gateway hands it. This file builds the SCANNER (the task an executor
# runs in a no-network sandbox: `python -I /opt/mcpscanner/scan.py <in> <out>`). The Node runner shim joins it
# as the image's runner stage in phase 2 (ADR-0242 §6); until an image is published and recorded in
# engines/images.lock.json the engine carries no digest and cannot be enabled.
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
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node
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
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=closure /opt/mcpscanner /opt/mcpscanner
COPY engines/mcpscanner/fixtures /opt/mcpscanner/fixtures
RUN chmod -R a-w /opt/mcpscanner \
 && mkdir -p /work /in /out && chown 10001:10001 /work /in /out
# LITELLM_LOCAL_MODEL_COST_MAP: litellm (imported by mcpscanner's package root) otherwise fetches a remote price
# map at import time (measured: six connect() calls without it, none with it). The driver sets it again and
# refuses to run with any cloud analyzer credential in its environment.
ENV HOME=/work \
    LANG=C.UTF-8 \
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
ENTRYPOINT ["/opt/mcpscanner/venv/bin/python", "-I", "/opt/mcpscanner/scan.py"]
CMD ["/in", "/out/report.json"]
