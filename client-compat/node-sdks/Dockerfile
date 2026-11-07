# ADR-0257 — the official OpenAI and Anthropic SDKs, pinned by package-lock.json and
# installed at IMAGE BUILD. At test time the container has no route out: the harness
# runs it on an `--internal` docker network whose only reachable host is the gateway.
#
# node:22-alpine, pinned by its multi-arch index digest.
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS deps
WORKDIR /client
COPY package.json package-lock.json ./
# `extra_ca` is an OPTIONAL build secret for a builder behind a TLS-intercepting proxy
# (CI does not pass it). It lives only in this discarded stage.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /client
COPY --from=deps /client/node_modules ./node_modules
COPY package.json run.mjs ./
USER node
ENTRYPOINT ["node", "run.mjs"]
