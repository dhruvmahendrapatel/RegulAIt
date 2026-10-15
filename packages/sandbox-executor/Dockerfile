# ADR-0190 slice I4 — THE SANDBOX EXECUTOR IMAGE (the `gvisor` backend).
#
# Build from the repository root:
#   docker build -f packages/sandbox-executor/Dockerfile -t regulait/sandbox-executor:local .
#
# NOT EXECUTED in the session that wrote it (no Docker daemon there; M-041). The
# executor's TypeScript is built and tested by CI (`pnpm -r build`, the package
# suite); this image build is not yet a CI step. See ADR-0190 "As built: slice I4".
#
# What is in it: Node 22 (the same pinned base as the gateway), the executor's
# production closure (`pnpm deploy --prod`), and Docker's own CLI (copied from
# the official `docker` CLI image, pinned by digest; Apache-2.0) — the executor
# starts each sandbox with `docker run --runtime runsc` on the HOST's daemon,
# whose socket compose mounts. gVisor itself is installed on the host and
# registered with that daemon (INSTALL.md); it is not in this image.
#
# What is NOT in it: npm, npx, corepack (removed from the runtime stage), any
# secret (the executor generates its own key on its state volume at first start).
FROM --platform=linux/amd64 docker:29.3.1-cli@sha256:18f5ab0fab739ea822819b342357947dfba235cdef438cce345ebc0c143c5b34 AS dockercli

FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm install --frozen-lockfile \
 && pnpm --filter "@regulait/sandbox-executor..." build \
 && pnpm --filter @regulait/sandbox-executor deploy --prod --legacy /out

FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS runtime
LABEL org.opencontainers.image.title="regulait-sandbox-executor" \
      org.regulait.backend="gvisor"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /out /app
# review H2: the executor-controlled sandbox init (hash-pinned in src/init-pin.ts; the executor refuses any other
# bytes). It is copied at start into the init volume and mounted READ-ONLY into every sandbox as its entry point.
COPY --chmod=0444 packages/sandbox-executor/sandbox-init/sandbox-init.mjs /app/sandbox-init/sandbox-init.mjs
# the init volume's mount point, owned by the executor's uid (compose mounts the named volume here)
RUN mkdir -p /regulait-init && chown 10001:10001 /regulait-init
# the executor's own state volume: its key (0600, written by the executor itself) survives a restart
RUN mkdir -p /state && chown 10001:10001 /state && chmod 0700 /state
ENV NODE_ENV=production \
    REGULAIT_EXECUTOR_KEY_FILE=/state/executor-key.json \
    REGULAIT_EXECUTOR_BACKEND=gvisor
USER 10001:10001
WORKDIR /state
CMD ["node", "/app/dist/main.js"]
