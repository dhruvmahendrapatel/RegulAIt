# RegulAIt gateway — dev-grade image (single stage, workspace layout kept so
# the gateway finds packages/db/migrations relative to its dist output).
#
# Build stage note (ADR-0026): `pnpm -r build` includes @regulait/web, so the
# image carries apps/web/dist and the gateway serves the React SPA at /ui, which
# is the whole product surface (ADR-0033 deleted the /app and /admin shells).
# Without that dist the /ui routes answer an explicit 503 "web_bundle_not_built"
# — never a blank page.
FROM node:22-slim
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

ENV PORT=3000
EXPOSE 3000

# Migrations run on boot (idempotent). SEED_DEMO=1 loads the demo dataset
# first — also idempotent, keys are printed to the container log ONCE.
CMD ["sh", "-c", "if [ \"$SEED_DEMO\" = \"1\" ]; then node apps/gateway/dist/seed.js; fi; exec node apps/gateway/dist/main.js"]
