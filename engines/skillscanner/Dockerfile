# ADR-0242 — the skillscanner engine image: Cisco skill-scanner 2.3.2 with ONLY its core local analyzers (static
# signatures on the baked YARA-X rule packs, bytecode, pipeline taint, correlation), run by our driver (scan.py) on
# one agent skill (SKILL.md and its bundled files) the gateway hands it. This file builds the SCANNER (the task an
# executor runs in a no-network sandbox: `python -I /opt/skillscanner/scan.py <skill-dir> <out>`). The Node runner
# shim joins it as the image's runner stage in phase 2 (ADR-0242 §6); until an image is published and recorded in
# engines/images.lock.json the engine carries no digest and cannot be enabled.
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f engines/skillscanner/Dockerfile -t regulait/engine-skillscanner:2.3.2 .
#
# Every base is pinned by digest. What the build does offline after the pinned download:
#   - skill-scanner 2.3.2 and its closure from OUR lockfile (requirements.txt: every wheel by sha256,
#     `--require-hashes --no-deps --only-binary :all:`), into a venv; pip is removed afterwards;
#   - pcodedmp (GPL-3.0) is NOT installed (oletools' optional P-code path, which skill-scanner never takes), and
#     oletools' unlicensed xxxswf code is pruned; the build fails if either is present, and checks that the
#     Office-document check skill-scanner does use (`oletools.oleid`) still imports;
#   - the licence gate (licence-gate.mjs) on the INSTALLED closure;
#   - the rule packs skill-scanner loads (YARA-X rules, signatures, CEL gates, inside its wheel) must hash to
#     rules.sha256 (committed): a rules change is a reviewed change, never a silent one;
#   - an offline smoke scan of a known-bad and a clean skill, with no network, must flag and pass.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: the Python closure ----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/skillscanner/requirements.txt engines/skillscanner/licence-gate.mjs engines/skillscanner/licence-allow.json engines/skillscanner/licence-readings.json engines/skillscanner/rules.sha256 ./
COPY engines/skillscanner/scan.py /opt/skillscanner/scan.py
ENV SP=/opt/skillscanner/venv/lib/python3.12/site-packages
RUN python -m venv /opt/skillscanner/venv \
 && /opt/skillscanner/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/skillscanner/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('cisco-ai-skill-scanner'); sys.exit(0 if v == '2.3.2' else f'expected skill-scanner 2.3.2, got {v}')" \
 && /opt/skillscanner/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && rm -rf "$SP/oletools/thirdparty/xxxswf" "$SP/oletools/pyxswf.py" \
 && if [ -e "$SP/pcodedmp" ] || ls -d "$SP"/pcodedmp-* >/dev/null 2>&1; then echo "pcodedmp must not ship" >&2; exit 1; fi \
 && /opt/skillscanner/venv/bin/python -I -c "from oletools.oleid import OleID" \
 && node licence-gate.mjs "$SP" licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && cp rules.sha256 /opt/skillscanner/rules.sha256 \
 && find /opt/skillscanner/venv -name '__pycache__' -prune -exec rm -rf {} +

# ---- stage 2: runtime ---------------------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-skillscanner" \
      org.regulait.engine="skillscanner" \
      org.regulait.engine-version="2.3.2" \
      org.regulait.analyzers="static,bytecode,pipeline,correlation" \
      org.regulait.excluded="pcodedmp,oletools-xxxswf"
RUN rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
COPY --from=closure /opt/skillscanner /opt/skillscanner
COPY engines/skillscanner/fixtures /opt/skillscanner/fixtures
RUN chmod -R a-w /opt/skillscanner \
 && mkdir -p /work /in /out && chown 10001:10001 /work /in /out
ENV HOME=/work \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    LITELLM_TELEMETRY=False \
    HF_HUB_OFFLINE=1 \
    REGULAIT_SKILLSCANNER_RULES_DIR=/opt/skillscanner/venv/lib/python3.12/site-packages/skill_scanner/data/packs \
    REGULAIT_SKILLSCANNER_RULES_MANIFEST=/opt/skillscanner/rules.sha256
USER 10001:10001
WORKDIR /work
RUN --network=none /opt/skillscanner/venv/bin/python -I /opt/skillscanner/scan.py /opt/skillscanner/fixtures/bad /work/bad.json \
 && /opt/skillscanner/venv/bin/python -I -c "import json,sys; r=json.load(open('/work/bad.json')); sys.exit(0 if r['status']=='completed' and any(f['severity'] in ('high','critical') for f in r['findings']) else 'bad fixture not flagged')" \
 && /opt/skillscanner/venv/bin/python -I /opt/skillscanner/scan.py /opt/skillscanner/fixtures/clean /work/clean.json \
 && /opt/skillscanner/venv/bin/python -I -c "import json,sys; r=json.load(open('/work/clean.json')); sys.exit(0 if r['status']=='completed' and not [f for f in r['findings'] if f['severity'] in ('medium','high','critical')] else 'clean fixture flagged')" \
 && rm -f /work/bad.json /work/clean.json
ENTRYPOINT ["/opt/skillscanner/venv/bin/python", "-I", "/opt/skillscanner/scan.py"]
CMD ["/in", "/out/report.json"]
