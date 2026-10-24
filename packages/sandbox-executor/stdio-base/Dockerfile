# ADR-0190 slice I4 — THE REGULAIT STDIO BASE IMAGE.
#
# Every stdio MCP server's CLOSURE IMAGE is built FROM this base. The base
# provides the interpreter (Node 22 at /usr/local/bin/node) that the executor's
# sandbox init runs under. Review H2: the init itself is NOT in this image. The
# executor ships it, checks its pinned SHA-256, mounts it READ-ONLY from a volume
# it owns at /.regulait-init and sets it as the sandbox's entry point, so a
# closure image can neither replace nor shadow it. What the init prints only
# corroborates; the runtime is decided from outside the sandbox (the container's
# runtime and the runsc binary's pinned hash).
#
# Build from packages/sandbox-executor:
#   docker build -f stdio-base/Dockerfile -t regulait/stdio-base:local .
#   docker image inspect --format '{{.Id}}' regulait/stdio-base:local   # the digest the executor's
#                                                                        # REGULAIT_EXECUTOR_CANARY_IMAGE names
#
# NOT EXECUTED in the session that wrote it (no Docker daemon there; M-041).
#
# The init needs `unshare` and `dmesg` (util-linux) for two of its probes; a base
# without them reports those probes as not run, and the gateway fails the report
# (fail closed, never a pass).
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
LABEL org.opencontainers.image.title="regulait-stdio-base"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# the profile's uid; the executor also passes --user, so this is the default only
USER 10001:10001
WORKDIR /work
# no ENTRYPOINT that matters: the executor always sets --entrypoint to Node and runs its own mounted init
