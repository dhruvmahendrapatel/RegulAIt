# RegulAIt gateway — dev-grade image (single stage, workspace layout kept so
# the gateway finds packages/db/migrations relative to its dist output).
#
# Build stage note (ADR-0026): `pnpm -r build` includes @regulait/web, so the
# image carries apps/web/dist and the gateway serves the React SPA at /ui
# (alongside the legacy /app and /admin shells). Without that dist the /ui
# routes answer an explicit 503 "web_bundle_not_built" — never a blank page.
FROM node:22-slim
LABEL org.regulait.build-stage="workspace-build+runtime"

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# builds every workspace package INCLUDING apps/web (vite → apps/web/dist)
RUN pnpm install --frozen-lockfile && pnpm -r build

ENV PORT=3000
EXPOSE 3000

# Migrations run on boot (idempotent). SEED_DEMO=1 loads the demo dataset
# first — also idempotent, keys are printed to the container log ONCE.
CMD ["sh", "-c", "if [ \"$SEED_DEMO\" = \"1\" ]; then node apps/gateway/dist/seed.js; fi; exec node apps/gateway/dist/main.js"]
