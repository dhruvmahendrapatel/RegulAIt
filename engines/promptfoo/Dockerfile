# ADR-0187 B5-P — the promptfoo engine runner image.
#
# Built from the REPOSITORY ROOT (the shim is a workspace package):
#
#   docker build -f engines/promptfoo/Dockerfile -t regulait/engine-promptfoo:0.123.1 .
#
# Signing and the image-level Trivy scan (vulnerabilities and the OS-layer licence scan) join the
# gateway image's pipeline (ADR-0184: publish-image.yml / security.yml) in a follow-up: they need a
# registry push and CI's keyless identity, so nothing here claims them yet. What this file does
# offline: the npm licence gate, the CycloneDX SBOM of the npm closure (/opt/promptfoo/sbom.cdx.json)
# and the telemetry patch.
# The shipped manifest (packages/shared/src/engines/manifest.ts) carries NO digest until an image
# has actually been built and its digest recorded there; until then no runner can pass the
# self-test and the engine cannot be enabled.
#
# What the image is:
#   - promptfoo exactly as pinned by engines/promptfoo/package-lock.json (npm ci, no optional
#     dependencies, no install scripts), with one patch (patches/telemetry-disabled-sends-nothing.mjs)
#     that stops the disabled-telemetry path from attempting a request; the patch refuses to apply
#     unless it finds exactly the code it expects;
#   - the runner shim (@regulait/engine-promptfoo) and its workspace dependencies, production only;
#   - every usage-data and remote-fetch switch set in the image environment (the runner's
#     self-test reports them; the adapter sets them again for each promptfoo process);
#   - no npm, npx or corepack at run time; a non-root uid; no listening port; nothing downloaded at
#     run time. Compose runs it with a read-only root filesystem, tmpfs /work and /tmp, no
#     capabilities, on the internal-only `engines` network (docker-compose.yml, x-engine-runner).
#
# The base is the gateway image's pinned base (same digest), so one base is patched and scanned.
#
# linux/amd64 ONLY (PR #205 review [51]): promptfoo's sqlite store needs libsql's native binding,
# pinned here as `@libsql/linux-x64-gnu` (an upstream optional dependency we must install
# explicitly because the closure is installed with --omit=optional). Every stage names the
# platform, so a build on an arm64 host emulates amd64 instead of producing an image whose native
# binding cannot load. arm64 is an open item (ADR-0187 open question 10).

# ---- stage 1: the pinned promptfoo release -----------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS promptfoo
WORKDIR /opt/promptfoo
COPY engines/promptfoo/package.json engines/promptfoo/package-lock.json engines/promptfoo/licence-gate.mjs ./
# the licence gate runs on the lockfile BEFORE anything is installed (no GPL family, no unknown);
# the CycloneDX SBOM of exactly what was installed ships inside the image (npm's own `npm sbom`)
RUN node licence-gate.mjs package-lock.json \
 && npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
 && node -e "const v=require('./node_modules/promptfoo/package.json').version; if (v !== '0.123.1') { console.error('expected promptfoo 0.123.1, got ' + v); process.exit(1); }" \
 && npm sbom --omit=optional --sbom-format cyclonedx --sbom-type application > sbom.cdx.json \
 && rm -rf /root/.npm licence-gate.mjs
COPY engines/promptfoo/patches/telemetry-disabled-sends-nothing.mjs /tmp/telemetry-patch.mjs
RUN node /tmp/telemetry-patch.mjs /opt/promptfoo/node_modules/promptfoo && rm /tmp/telemetry-patch.mjs

# ---- stage 2: the runner shim -----------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/engine-promptfoo..." build \
 && pnpm --filter @regulait/engine-promptfoo deploy --prod --legacy /out

# ---- stage 3: runtime -------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS runtime
LABEL org.opencontainers.image.title="regulait-engine-promptfoo" \
      org.regulait.engine="promptfoo" \
      org.regulait.engine-version="0.123.1" \
      org.regulait.patches="telemetry-disabled-sends-nothing"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=promptfoo /opt/promptfoo /opt/promptfoo
COPY --from=shim /out /app
# the runner's own state volume (PR #205 review [49]): the runner token survives a restart. Owned by
# the runner uid and 0700 here, so a fresh named volume mounted on it inherits both.
RUN mkdir -p /state && chown 10001:10001 /state && chmod 0700 /state
# REGULAIT_EGRESS_PROBE_ADDRESS: the public literal address the egress self-test must FAIL to reach
# (ADR-0187 decision 19). The PROMPTFOO_* values are the manifest's usage-data switches
# (PROMPTFOO_USAGE_DATA_ENV); packages/engine-promptfoo/src/image.test.ts keeps the two in lockstep.
ENV NODE_ENV=production \
    HOME=/work \
    REGULAIT_WORK_DIR=/work \
    REGULAIT_RUNNER_STATE_DIR=/state \
    REGULAIT_PROMPTFOO_HOME=/opt/promptfoo/node_modules/promptfoo \
    REGULAIT_EGRESS_PROBE_ADDRESS=93.184.215.14 \
    PROMPTFOO_DISABLE_TELEMETRY=1 \
    PROMPTFOO_DISABLE_UPDATE=1 \
    PROMPTFOO_DISABLE_SHARING=1 \
    PROMPTFOO_DISABLE_REMOTE_GENERATION=1 \
    PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION=1 \
    PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS=1 \
    PROMPTFOO_DISABLE_REDTEAM_MODERATION=1 \
    PROMPTFOO_CACHE_ENABLED=false
USER 10001:10001
WORKDIR /work
CMD ["node", "/app/dist/main.js"]
