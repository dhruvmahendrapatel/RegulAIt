# ADR-0364 S3 — the ROBOT RUNNER image: one approved robot run inside a robot_browser sandbox (§5). UNPUBLISHED: built
# twice and compared by engine-images-build.yml and scanned by security.yml, never pushed or locked yet.
#
# Built from the REPOSITORY ROOT (the runner is a workspace package):
#
#   docker build -f engines/robot-runner/Dockerfile -t regulait/engine-robot-runner:0.1.0 .
#
# What the image is:
#   - @regulait/robot-runner and its workspace dependencies, production only (`pnpm deploy --prod`), with
#     playwright-core 1.65.1 exactly as pnpm-lock.yaml pins it; the npm licence gate runs on what was deployed;
#   - Playwright's Chrome Headless Shell for playwright-core 1.65.1 (revision 1255, Chrome for Testing 159.0.8154.6),
#     installed at BUILD time into PLAYWRIGHT_BROWSERS_PATH by playwright-core's own installer and checked against the
#     executable's pinned sha256; Playwright's ffmpeg (video recording, which we never use) is removed;
#     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 at run time, so nothing is downloaded when a robot runs (air-gapped);
#   - the browser's system libraries from Debian (playwright-core `install-deps`), then the apt lists and logs removed;
#   - no npm, npx or corepack; a non-root uid; no listening port. The sandbox runs it with a read-only root, a tmpfs
#     /work, the run key on fd 3, REGULAIT_ROBOT_RUN_ID and REGULAIT_ROBOT_EGRESS_PROXY set, and no network but its own
#     Smokescreen (engines/robot-egress).
#
# The base is the gateway image's pinned base (same digest), so one base is patched and scanned. linux/amd64 only (the
# headless shell build is linux64).

# ---- stage 1: the runner, built and deployed with production dependencies ---------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS shim
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts/engine-images-normalise.mjs ./scripts/engine-images-normalise.mjs
COPY engines/robot-runner/licence-gate.mjs engines/robot-runner/licence-allow.json /gate/
ARG SOURCE_DATE_EPOCH
RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/robot-runner..." build \
 && pnpm --filter @regulait/robot-runner deploy --prod --legacy /out \
 && node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml \
 && node /gate/licence-gate.mjs /out /gate/licence-allow.json \
 && node -e "const v=require('/out/node_modules/playwright-core/package.json').version; if (v !== '1.65.1') { console.error('expected playwright-core 1.65.1, got ' + v); process.exit(1); }"

# ---- stage 2: the browser, from Playwright's own installer at build time ---------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS browser
COPY --from=shim /out/node_modules/playwright-core /pw/playwright-core
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node /pw/playwright-core/cli.js install --only-shell chromium \
 && rm -rf /ms-playwright/ffmpeg-* \
 && echo "24eb0a14de64ab0c9c2e283a5512ca817db64af8fd853cdb4d818f19a8e23b9b  /ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell" | sha256sum -c - \
 && ls /ms-playwright

# ---- stage 3: runtime -------------------------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS runtime
LABEL org.opencontainers.image.title="regulait-engine-robot-runner" \
      org.regulait.engine="robot-runner" \
      org.regulait.engine-version="playwright-core-1.65.1"
COPY --from=shim /out /app
# ADR-0184 / ADR-0200 (patch, never allow-list): the zlib1g fix the promptfoo image applies to this same base digest,
# then the headless shell's system libraries (playwright-core's own list for this Debian release); the apt lists, logs
# (alternatives.log carries the install time) and ldconfig's aux-cache are removed so the layer stays byte-reproducible.
# So is fontconfig's system cache (/var/cache/fontconfig): fc-cache writes different bytes on every build (measured: two
# installs of the same packages, every cache file differs). With a read-only root, fontconfig builds its cache under
# HOME (/work, the run's tmpfs) when the browser starts.
# CVE-2026-124851 (libzstd1, HIGH, 2026-11-25): the same treatment. Neither the pinned base digest nor the
# newest published one ships the fix; trixie-security has 1.5.7+dfsg-1+deb13u1. Remove with the zlib1g pin.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 libzstd1=1.5.7+dfsg-1+deb13u1 \
 && node /app/node_modules/playwright-core/cli.js install-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache \
          /var/cache/apt/*.bin /var/cache/fontconfig/*
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=browser /ms-playwright /ms-playwright
RUN mkdir -p /work && chown 10001:10001 /work && chmod 0700 /work
# N7: the sandbox init gives the workload only PATH, HOME, the run's proxy and run id, and from this ENV exactly
# PLAYWRIGHT_BROWSERS_PATH, ROBOT_CHROMIUM (absolute paths) and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1. No `REGULAIT_` name is
# set here: the init's credential scan counts every one in its environment (the runner's work directory is /work, its
# default, the profile's tmpfs).
ENV NODE_ENV=production \
    HOME=/work \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ROBOT_CHROMIUM=/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell
USER 10001:10001
WORKDIR /work
CMD ["node", "/app/dist/main.js"]
