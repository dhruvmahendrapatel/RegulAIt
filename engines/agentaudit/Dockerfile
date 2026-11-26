# ADR-0355 — the agentaudit engine image: manifold-security/agentaudit v0.1.2 (Apache-2.0, Go), linked into OUR
# driver (engines/agentaudit/driver) as a library. The driver reads one bundle of a repository's agent
# configuration (`agent-config.json`, placed by the gateway), scans it in memory, and writes a
# `regulait.agent-config-audit.v1` report of rule ids and locations, never values.
#
# PHASE 1 (this image): the driver and its offline smoke scan. The runner shim (packages/engine-admission-scan's
# subject lease, as for mcpscanner) is added in phase 2 (ADR-0355 §6); until an image is published and recorded
# in engines/images.lock.json the engine carries no digest and cannot be enabled (ADR-0187 decision 3).
#
# Built from the REPOSITORY ROOT:
#
#   docker build -f engines/agentaudit/Dockerfile -t regulait/engine-agentaudit:0.1.2 .
#
# Every base is pinned by digest. The Go module downloads happen at build time only and are checked against the
# committed go.sum (GOFLAGS=-mod=readonly, the checksum database on); the driver binary is static (CGO off),
# built with -trimpath and no build id, and refuses to run when the linked agentaudit is not v0.1.2.
#
# linux/amd64 ONLY, as the other engine images.

# ---- stage 1: the driver, with agentaudit linked in ---------------------------------------------------------
FROM --platform=linux/amd64 golang:1.27-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS build
ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=readonly \
    GOTOOLCHAIN=local \
    GOSUMDB=sum.golang.org \
    GOPROXY=https://proxy.golang.org
WORKDIR /src
COPY engines/agentaudit/driver/go.mod engines/agentaudit/driver/go.sum ./
RUN go mod download && go mod verify
COPY engines/agentaudit/driver/main.go ./
RUN go build -trimpath -ldflags='-s -w -buildid=' -o /out/agentaudit-driver . \
 && go version -m /out/agentaudit-driver | grep -E 'dep\s+github.com/manifold-security/agentaudit\s+v0\.1\.2\s' \
 && mkdir -p /out/licences/agentaudit \
 && cp "$(go env GOMODCACHE)/github.com/manifold-security/agentaudit@v0.1.2/LICENSE" "$(go env GOMODCACHE)/github.com/manifold-security/agentaudit@v0.1.2/NOTICE" /out/licences/agentaudit/ \
 && for m in github.com/pelletier/go-toml/v2@v2.4.3 gopkg.in/yaml.v3@v3.0.1; do \
      d="/out/licences/$(echo "$m" | tr '/@' '__')"; mkdir -p "$d"; cp "$(go env GOMODCACHE)/$m/LICENSE" "$d/"; \
    done

# ---- stage 2: runtime ---------------------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-agentaudit" \
      org.regulait.engine="agentaudit" \
      org.regulait.engine-version="0.1.2"
# ADR-0184 / ADR-0200 (patch, never allow-list): the same zlib1g fix the other engine images carry
# CVE-2026-124851 (libzstd1, HIGH, 2026-11-25): the same treatment. Neither the pinned base digest nor the
# newest published one ships the fix; trixie-security has 1.5.7+dfsg-1+deb13u1. Remove with the zlib1g pin.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 libzstd1=1.5.7+dfsg-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
# no package manager for JavaScript at run time
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /out/agentaudit-driver /opt/agentaudit/agentaudit-driver
COPY --from=build /out/licences /opt/agentaudit/licences
COPY engines/agentaudit/fixtures /opt/agentaudit/fixtures
RUN chmod -R a-w /opt/agentaudit \
 && mkdir -p /work && chown 10001:10001 /work
ENV HOME=/work LANG=C.UTF-8
USER 10001:10001
WORKDIR /work
# the smoke scan, offline, in the image as built: the known-bad bundle must complete with its findings (the
# rules in it are in the shared catalogue at high), and the minimal one must complete with exactly its one MCP
# server and nothing else
RUN --network=none /opt/agentaudit/agentaudit-driver /opt/agentaudit/fixtures/bad /work/bad.json \
 && node -e "const r=require('/work/bad.json'); const s=new Set(r.findings.map(f=>f.rule)); for (const id of ['claude.sandbox.dangerous-socket','codex.approval.never','cursor.sandbox.disabled','cursor.hook.workspace-open']) if (!s.has(id)) { console.error('bad fixture not flagged: '+id); process.exit(1) } if (r.status!=='completed'||r.unreadableSources||r.unparsedSources) process.exit(1); if (/docker\.sock|https?:\/\//.test(JSON.stringify(r))) { console.error('a value reached the report'); process.exit(1) }" \
 && /opt/agentaudit/agentaudit-driver /opt/agentaudit/fixtures/minimal /work/minimal.json \
 && node -e "const r=require('/work/minimal.json'); if (r.status!=='completed'||r.findings.length!==1||r.findings[0].rule!=='claude.mcp.server') { console.error('minimal fixture'); process.exit(1) }" \
 && rm -f /work/bad.json /work/minimal.json \
 && leftover="$(ls -A /work /tmp | grep -v -e '^/' -e '^$' || true)" \
 && { [ -z "$leftover" ] || { echo "the smoke scan left files in the image: $leftover" >&2; exit 1; }; }
CMD ["/opt/agentaudit/agentaudit-driver"]
