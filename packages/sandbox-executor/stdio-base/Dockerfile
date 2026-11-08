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
FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6
LABEL org.opencontainers.image.title="regulait-stdio-base"
# ADR-0184 / ADR-0200 (patch, never allow-list): CVE-2026-76844 and CVE-2026-85091 (zlib1g, HIGH).
# The pinned base digest is still the newest published one and ships 1:1.3.dfsg+really1.3.1-1+b1;
# the fix is in Debian trixie-security. Upgrade exactly that package to exactly the fixed version,
# then drop what apt and dpkg wrote with wall-clock content (the lists, their logs and ldconfig's
# aux-cache), so the layer stays byte-reproducible (ADR-0187 addendum 2026-10-21: build and rebuild
# must match). Remove this when a rebuilt base digest already carries the fix.
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# the profile's uid; the executor also passes --user, so this is the default only
USER 10001:10001
WORKDIR /work
# no ENTRYPOINT that matters: the executor always sets --entrypoint to Node and runs its own mounted init
