# ADR-0364 S3 — the ROBOT EGRESS image: stripe/smokescreen (MIT), the per-run CONNECT proxy that is a robot_browser
# sandbox's only network peer (§7). One static binary on a distroless base, non-root, no shell. UNPUBLISHED: built
# twice and compared by engine-images-build.yml and scanned by security.yml, never pushed or locked yet.
#
#   docker build -f engines/robot-egress/Dockerfile -t regulait/engine-robot-egress:0.1.0 .
#
# Pinned: smokescreen v0.1.0 (tag of commit 609eb8931420453daf5893509be0b25b21bd9edb, 2026-09-18), its module zip by
# its go.sum hash (h1:E9Nd/WWMkMK3QAvCTlxiRBh1jTYyVy3BmXRci+zkXH8=, the checksum database's record), every dependency
# by smokescreen's own go.sum (`-mod=readonly`, `go mod verify`). Modules are fetched at BUILD time only; the image runs
# air-gapped. The licence gate judges exactly the modules the built binary links (`go version -m`).
#
# How the executor runs it, and the flags it adds per run: engines/robot-egress/README.md.

FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node

# ---- stage 1: build smokescreen from the published module ----------------------------------------------------------
FROM --platform=linux/amd64 golang:1.27-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY engines/robot-egress/licence-gate.mjs engines/robot-egress/licence-allow.json engines/robot-egress/licence-readings.json /gate/
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
WORKDIR /tmp/fetch
RUN test "$(go env GOVERSION)" = "go1.27.4" \
 && go mod download -json github.com/stripe/smokescreen@v0.1.0 > /tmp/smokescreen.json \
 && node -e 'const j = require("/tmp/smokescreen.json"); if (j.Sum !== "h1:E9Nd/WWMkMK3QAvCTlxiRBh1jTYyVy3BmXRci+zkXH8=" || j.Origin?.Hash !== "609eb8931420453daf5893509be0b25b21bd9edb") { console.error("smokescreen v0.1.0 is not the pinned module"); process.exit(1); } console.log(j.Dir)' > /tmp/smokescreen.dir \
 && cp -r "$(cat /tmp/smokescreen.dir)" /src && chmod -R u+w /src
WORKDIR /src
RUN go mod download && go mod verify \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/smokescreen . \
 && go version -m /out/smokescreen | tee /tmp/buildinfo.txt \
 && node /gate/licence-gate.mjs /tmp/buildinfo.txt "$(go env GOMODCACHE)" /src \
 && mkdir -p /out/licences && cp /src/LICENSE.txt /out/licences/smokescreen-LICENSE.txt

# ---- stage 2: runtime --------------------------------------------------------------------------------------------
FROM --platform=linux/amd64 gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
LABEL org.opencontainers.image.title="regulait-engine-robot-egress" \
      org.regulait.engine="robot-egress" \
      org.regulait.engine-version="smokescreen-0.1.0"
COPY --from=build /out/smokescreen /usr/local/bin/smokescreen
COPY --from=build /out/licences /usr/share/doc/smokescreen
COPY engines/robot-egress/smokescreen.yaml /etc/regulait/smokescreen.yaml
USER 65532:65532
EXPOSE 4750
# The strict actions are fixed here: an ACL that names `open` or `report` is refused at load. The executor appends
# `--egress-acl-file <the run's ACL>` (and `--listen-ip` where the sandbox network needs it).
ENTRYPOINT ["/usr/local/bin/smokescreen", "--config-file", "/etc/regulait/smokescreen.yaml", "--disable-acl-policy-action", "open", "--disable-acl-policy-action", "report"]
