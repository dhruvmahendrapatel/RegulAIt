# RegulAIt gateway — dev-grade image (single stage, workspace layout kept so
# the gateway finds packages/db/migrations relative to its dist output).
FROM node:22-slim

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile && pnpm -r build

ENV PORT=3000
EXPOSE 3000

# Migrations run on boot (idempotent). SEED_DEMO=1 loads the demo dataset
# first — also idempotent, keys are printed to the container log ONCE.
CMD ["sh", "-c", "if [ \"$SEED_DEMO\" = \"1\" ]; then node apps/gateway/dist/seed.js; fi; exec node apps/gateway/dist/main.js"]
