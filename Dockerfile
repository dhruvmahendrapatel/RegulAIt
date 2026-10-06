# RegulAIt gateway — dev-grade image (single stage, workspace layout kept so
# the gateway finds packages/db/migrations relative to its dist output).
#
# Build stage note (ADR-0026): `pnpm -r build` includes @regulait/web, so the
# image carries apps/web/dist and the gateway serves the React SPA at /ui, which
# is the whole product surface (ADR-0033 deleted the /app and /admin shells).
# Without that dist the /ui routes answer an explicit 503 "web_bundle_not_built"
# — never a blank page.
# ADR-0167 (CFG-07): pinned by DIGEST, not by the floating tag, so a
# base-image rebuild cannot change the runtime underneath a reproducible
# build. Bump deliberately: `docker buildx imagetools inspect node:22-trixie-slim`
# prints the current index digest, and security.yml's Trivy gate must pass on
# the new one (docs/ops/SECURITY_CI.md).
#
# ADR-0184: Debian 13 (trixie) rather than the `22-slim` default (Debian 12).
# On 2026-10-06 the bookworm image carried seven fixable HIGH/CRITICAL CVEs in
# perl-base (fixed in 5.36.0-7+deb12u4, not yet in the image); the trixie image
# of the same Node 22 line carried none. Digest of node:22-trixie-slim as
# published 2026-10-06T05:38Z (linux/amd64 + arm64 index).
FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
LABEL org.regulait.build-stage="workspace-build+runtime"

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# builds every workspace package INCLUDING apps/web (vite → apps/web/dist)
#
# NODE_OPTIONS is load-bearing on a small box, not tuning. Node sizes its
# default old-space heap from available RAM; on the 2 GB dev instance
# (ADR-0013) that lands near ~1 GB, and after the ADRs 0036-0061 wave the
# gateway's type graph no longer fits — `tsc` died with SIGABRT / exit 134
# ("Aborted (core dumped)"), which reads like a compiler crash but is a V8
# out-of-memory. The box has 4 GB of swap sitting almost entirely unused, so
# raising the ceiling lets the build spill there: slower, but it completes.
#
# Set on the build RUN only. The runtime CMD keeps Node's default, because a
# serving process that needs 3 GB of heap is a leak to investigate, not a
# limit to raise.
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && NODE_OPTIONS=--max-old-space-size=3072 pnpm -r build

# ADR-0184: the runtime runs only `node` and `sh` (docker-start.sh), never a
# package manager. The base image ships npm with its own bundled dependencies,
# which carried fixable HIGH advisories (brace-expansion, picomatch, pacote,
# sigstore, ip-address) on 2026-10-06, and corepack leaves the pnpm it fetched
# in its cache. Removing both after the build removes that code from the image
# instead of allow-listing it; corepack itself stays (it has no dependencies).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.cache/node/corepack

ENV PORT=3000
EXPOSE 3000

# ADR-0167 (CFG-07): the serving process is NOT root. The image's `node` user
# owns the one directory the gateway writes at runtime (the local audit-anchor
# buffer, ADR-0060's fallback when no S3 sink is configured) and the working
# directory itself; everything else is read-only to it, which is what a
# container escape or an RCE in a dependency then lands as.
#
# /app/demo-license-keys is the DEMO keyring (the licence's public key only),
# used solely when REGULAIT_DEMO_LICENSE=1 (see apps/gateway/docker-start.sh).
# In that mode it also holds export-signing/, the demo's export-signing keypair
# for the signed audit export (a demo key, like `demo:export-key` makes natively).
# docker-compose.yml mounts a named volume there; Docker copies this
# directory's owner and mode into a new volume, which is why it exists in the
# image and belongs to `node`.
#
# The start script is normalised to LF: a Windows checkout (git core.autocrlf=true)
# hands the build context a CRLF copy, and `sh` stops at the first stray carriage
# return ("Syntax error: newline unexpected"). .gitattributes pins *.sh to LF too;
# this keeps a checkout made before that rule bootable.
RUN sed -i 's/\r$//' apps/gateway/docker-start.sh \
 && mkdir -p /app/audit-anchors /app/demo-license-keys \
 && chown node:node /app /app/audit-anchors /app/demo-license-keys \
 && chmod 0700 /app/demo-license-keys
USER node

# ADR-0167 (CFG-07): an orchestrator can tell a wedged gateway from a live
# one. The image has no curl, so the probe is Node's own fetch against the
# same /health a load balancer polls (bounded by the gateway's own database
# deadline, so a hung pool reports unhealthy rather than hanging the probe).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Migrations run on boot (idempotent). SEED_DEMO=1 loads the demo dataset
# first — also idempotent, keys are printed to the container log ONCE.
# REGULAIT_DEMO_LICENSE=1 additionally lets that seed mint the ephemeral demo
# licence and prepares the demo like `demo:prepare` (demo MCP server, export key,
# setup → intake → traffic → check, once per database); unset (the default), the
# script is exactly the old one-liner:
#   if [ "$SEED_DEMO" = "1" ]; then node apps/gateway/dist/seed.js; fi; exec node apps/gateway/dist/main.js
CMD ["sh", "apps/gateway/docker-start.sh"]
