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
#   - the CEL helper skill-scanner runs as a subprocess is rebuilt from its hashed sdist with Go 1.27.3 (the wheel's
#     was built with Go 1.27.1, whose standard library carries published advisories), and its manifest rewritten;
#   - an offline smoke scan of a known-bad and a clean skill, with no network, must flag and pass.
#
# linux/amd64 ONLY: the hashes in requirements.txt are the cp312 manylinux x86_64 wheels.

# ---- stage 1: skill-scanner's CEL helper, rebuilt with a patched Go ----------------------------------------------
# The wheel bundles a Go helper built with Go 1.27.1, whose standard library carries published advisories. It is
# rebuilt here from skill-scanner 2.3.2's own sdist (sha256 checked) with Go 1.27.3 and the flags its packaging script
# uses; its Go modules are fetched by `go build` and checked against the sdist's go.sum (the module proxy and
# checksum database at BUILD time only). cel-helper.py swaps it in and rewrites the helper manifest.
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS sdist
WORKDIR /build
RUN python -I -c "import hashlib, sys, urllib.request; u = 'https://files.pythonhosted.org/packages/d8/77/c064e189682f5516579cba6dcc664c3c6243be8990f8fccabb7c188ab73c/cisco_ai_skill_scanner-2.3.2.tar.gz'; b = urllib.request.urlopen(u, timeout=120).read(); h = hashlib.sha256(b).hexdigest(); h == 'd019afd9c491794e4dda6cc05e629f2a0b2ce015bc65fbe91e514d5547b5e883' or sys.exit(f'sdist sha256 {h}'); open('/build/sdist.tar.gz', 'wb').write(b)" \
 && mkdir /src && tar -xzf /build/sdist.tar.gz -C /src --strip-components=1 cisco_ai_skill_scanner-2.3.2/tools/cel_runtime

FROM --platform=linux/amd64 golang:1.27-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS cel
COPY --from=sdist /src/tools/cel_runtime /src/cel_runtime
WORKDIR /src/cel_runtime
RUN test "$(go env GOVERSION)" = "go1.27.3" \
 && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS=-mod=readonly GOTOOLCHAIN=local \
    go build -trimpath -buildvcs=false -ldflags "-s -w -X main.helperVersion=2.3.2" -o /out/skill-scanner-cel-go-linux-amd64 . \
 && go version -m /out/skill-scanner-cel-go-linux-amd64 | head -3

# ---- stage 2: the Python closure ----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS closure
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY engines/skillscanner/requirements.txt engines/skillscanner/licence-gate.mjs engines/skillscanner/licence-allow.json engines/skillscanner/licence-readings.json engines/skillscanner/rules.sha256 ./
COPY engines/skillscanner/scan.py /opt/skillscanner/scan.py
COPY engines/skillscanner/cel-helper.py ./
COPY --from=cel /out/skill-scanner-cel-go-linux-amd64 /build/cel/skill-scanner-cel-go-linux-amd64
ENV SP=/opt/skillscanner/venv/lib/python3.12/site-packages
RUN python -m venv /opt/skillscanner/venv \
 && /opt/skillscanner/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements.txt \
 && /opt/skillscanner/venv/bin/python -I -c "import importlib.metadata as m, sys; v = m.version('cisco-ai-skill-scanner'); sys.exit(0 if v == '2.3.2' else f'expected skill-scanner 2.3.2, got {v}')" \
 && /opt/skillscanner/venv/bin/pip uninstall -y --disable-pip-version-check pip \
 && rm -rf "$SP/oletools/thirdparty/xxxswf" "$SP/oletools/pyxswf.py" \
 && if [ -e "$SP/pcodedmp" ] || ls -d "$SP"/pcodedmp-* >/dev/null 2>&1; then echo "pcodedmp must not ship" >&2; exit 1; fi \
 && /opt/skillscanner/venv/bin/python -I -c "from oletools.oleid import OleID" \
 && /opt/skillscanner/venv/bin/python -I cel-helper.py "$SP" /build/cel/skill-scanner-cel-go-linux-amd64 go1.27.3 \
 && node licence-gate.mjs "$SP" licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0 \
 && cp rules.sha256 /opt/skillscanner/rules.sha256 \
 && find /opt/skillscanner/venv -name '__pycache__' -prune -exec rm -rf {} +

# ---- stage 3: runtime ---------------------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim-trixie@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-skillscanner" \
      org.regulait.engine="skillscanner" \
      org.regulait.engine-version="2.3.2" \
      org.regulait.analyzers="static,bytecode,pipeline,correlation" \
      org.regulait.excluded="pcodedmp,oletools-xxxswf"
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
COPY --from=closure /opt/skillscanner /opt/skillscanner
COPY engines/skillscanner/fixtures /opt/skillscanner/fixtures
COPY engines/skillscanner/selftest.py /opt/skillscanner/selftest.py
RUN chmod -R a-w /opt/skillscanner \
 && mkdir -p /work /in /out && chown 10001:10001 /work /in /out
ENV HOME=/work \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    LITELLM_TELEMETRY=False \
    HF_HUB_OFFLINE=1 \
    ORT_DISABLE_TELEMETRY=1 \
    REGULAIT_SKILLSCANNER_RULES_DIR=/opt/skillscanner/venv/lib/python3.12/site-packages/skill_scanner/data/packs \
    REGULAIT_SKILLSCANNER_RULES_MANIFEST=/opt/skillscanner/rules.sha256
USER 10001:10001
WORKDIR /work
# the driver's fail-closed self-test: analyzers_failed, a failed or missing rule contract, an unexpected analyzer
# set and a result with no to_dict all fail (ADR-0242 review of #727)
RUN --network=none /opt/skillscanner/venv/bin/python -I /opt/skillscanner/selftest.py /opt/skillscanner/fixtures/results \
 && /opt/skillscanner/venv/bin/python -I /opt/skillscanner/scan.py /opt/skillscanner/fixtures/bad /work/bad.json \
 && /opt/skillscanner/venv/bin/python -I -c "import json,sys; r=json.load(open('/work/bad.json')); sys.exit(0 if r['status']=='completed' and any(f['severity'] in ('high','critical') for f in r['findings']) else 'bad fixture not flagged')" \
 && /opt/skillscanner/venv/bin/python -I /opt/skillscanner/scan.py /opt/skillscanner/fixtures/clean /work/clean.json \
 && /opt/skillscanner/venv/bin/python -I -c "import json,sys; r=json.load(open('/work/clean.json')); sys.exit(0 if r['status']=='completed' and not [f for f in r['findings'] if f['severity'] in ('medium','high','critical')] else 'clean fixture flagged')" \
 && rm -f /work/bad.json /work/clean.json \
 && leftover="$(ls -A /work /tmp | grep -v -e '^/' -e '^$' || true)" \
 && { [ -z "$leftover" ] || { echo "the smoke scan left files in the image (they would make it unreproducible): $leftover" >&2; exit 1; }; }
ENTRYPOINT ["/opt/skillscanner/venv/bin/python", "-I", "/opt/skillscanner/scan.py"]
CMD ["/in", "/out/report.json"]
