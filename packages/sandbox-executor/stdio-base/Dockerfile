# ADR-0190 slice I4 — THE REGULAIT STDIO BASE IMAGE.
#
# Every stdio MCP server's CLOSURE IMAGE is built FROM this base, so the sandbox
# init (/regulait/sandbox-init) is a file of the pinned image: the executor never
# mounts anything into a sandbox, and `exec: image_only` holds. The init probes
# from inside the sandbox before any input, waits for the gateway's release, then
# runs the registered entry point (sandbox-init/sandbox-init.mjs).
#
# Build from packages/sandbox-executor:
#   docker build -f stdio-base/Dockerfile -t regulait/stdio-base:local .
#   docker image inspect --format '{{.Id}}' regulait/stdio-base:local   # the digest the executor's
#                                                                        # REGULAIT_EXECUTOR_CANARY_IMAGE names
#
# NOT EXECUTED in the session that wrote it (no Docker daemon there; M-041). The
# init itself is tested (packages/sandbox-executor/src/runsc-backend.test.ts runs
# it); the image build is not yet a CI step. See ADR-0190 "As built: slice I4".
#
# The init needs `unshare` and `dmesg` (util-linux) for two of its probes; a base
# without them reports those probes as not run, and the gateway fails the report
# (fail closed, never a pass).
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
LABEL org.opencontainers.image.title="regulait-stdio-base"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && mkdir -p /regulait
COPY sandbox-init/sandbox-init.mjs /regulait/sandbox-init
# M-069: a Windows checkout's CRLF would break the shebang line; normalise, then read-only and executable
RUN sed -i 's/\r$//' /regulait/sandbox-init && chmod 0555 /regulait/sandbox-init
# the profile's uid; the executor also passes --user, so this is the default only
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/regulait/sandbox-init"]
