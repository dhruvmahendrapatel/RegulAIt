# ADR-0364 S3 — the ROBOT EGRESS image: stripe/smokescreen (MIT), the per-run CONNECT proxy that is a robot_browser
# sandbox's only network peer (§7), built as a library into ONE static binary with RegulAIt's port filter
# (`portfilter/`: smokescreen's own main.go plus a PostDecisionRequestHandler that refuses a destination port the run's
# targets do not name; ADR-0176 exception, ADR-0364 §7) and a front CONNECT filter (`front.go`) that the sandbox reaches
# instead of Smokescreen, which listens on loopback only (D-2026-11-22-07). Distroless base, non-root, no shell. UNPUBLISHED: built twice
# and compared by engine-images-build.yml and scanned by security.yml, never pushed or locked yet.
#
#   docker build -f engines/robot-egress/Dockerfile -t regulait/engine-robot-egress:0.1.0 .
#
# Pinned: smokescreen v0.1.0 (tag of commit 609eb8931420453daf5893509be0b25b21bd9edb, 2026-09-18), its module zip by
# its go.sum hash (h1:E9Nd/WWMkMK3QAvCTlxiRBh1jTYyVy3BmXRci+zkXH8=, the checksum database's record), every module by
# portfilter/go.sum (`-mod=readonly`, `go mod verify`). Modules are fetched at BUILD time only; the image runs
# air-gapped. The licence gate judges exactly the modules the built binary links (`go version -m`).
#
# How the executor runs it, and the flags it adds per run: engines/robot-egress/README.md.

FROM --platform=linux/amd64 node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node

# ---- stage 1: build the binary from the published smokescreen module and portfilter/ ------------------------------
FROM --platform=linux/amd64 golang:1.27-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY engines/robot-egress/licence-gate.mjs engines/robot-egress/licence-allow.json engines/robot-egress/licence-readings.json /gate/
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
WORKDIR /tmp/fetch
RUN test "$(go env GOVERSION)" = "go1.27.4" \
 && go mod download -json github.com/stripe/smokescreen@v0.1.0 > /tmp/smokescreen.json \
 && node -e 'const j = require("/tmp/smokescreen.json"); if (j.Sum !== "h1:E9Nd/WWMkMK3QAvCTlxiRBh1jTYyVy3BmXRci+zkXH8=" || j.Origin?.Hash !== "609eb8931420453daf5893509be0b25b21bd9edb") { console.error("smokescreen v0.1.0 is not the pinned module"); process.exit(1); }'
COPY engines/robot-egress/portfilter /src
WORKDIR /src
# Vulnerable dependencies are patched, never allow-listed (CLAUDE.md security checklist): smokescreen v0.1.0's go.mod
# pins logrus v1.9.0 (CVE-2025-65637), x/net v0.56.0 (CVE-2026-78661, CVE-2026-78669) and x/text v0.39.0
# (CVE-2026-56851). portfilter/go.mod requires the fixed releases (minimal version selection takes them over
# smokescreen's), and the resolved set is asserted exactly here; the licence gate re-reads every linked module.
RUN test "$(go list -m -f '{{.Version}}' github.com/stripe/smokescreen)" = "v0.1.0" \
 && test "$(go list -m -f '{{.Version}}' github.com/sirupsen/logrus)" = "v1.9.3" \
 && test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = "v0.62.0" \
 && test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v0.43.0" \
 && test "$(go list -m -f '{{.Version}}' golang.org/x/sys)" = "v0.49.0"
RUN go mod download && go mod verify \
 && go vet . && go test -count=1 . \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/robot-egress . \
 && go version -m /out/robot-egress | tee /tmp/buildinfo.txt \
 && node /gate/licence-gate.mjs /tmp/buildinfo.txt "$(go env GOMODCACHE)" \
 && mkdir -p /out/licences && cp "$(go env GOMODCACHE)/github.com/stripe/smokescreen@v0.1.0/LICENSE.txt" /out/licences/smokescreen-LICENSE.txt

# ---- stage 2: runtime --------------------------------------------------------------------------------------------
FROM --platform=linux/amd64 gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
LABEL org.opencontainers.image.title="regulait-engine-robot-egress" \
      org.regulait.engine="robot-egress" \
      org.regulait.engine-version="smokescreen-0.1.0"
COPY --from=build /out/robot-egress /usr/local/bin/robot-egress
COPY --from=build /out/licences /usr/share/doc/smokescreen
COPY engines/robot-egress/smokescreen.yaml /etc/regulait/smokescreen.yaml
USER 65532:65532
EXPOSE 4750
# The strict actions are fixed here: an ACL that names `open` or `report` is refused at load. The executor appends
# `--egress-acl-file <the run's ACL>` and `--listen-ip`, and mounts the run's ports file (portfilter.go's PortsFile)
# beside the ACL; without a valid ports file the binary exits before it listens.
ENTRYPOINT ["/usr/local/bin/robot-egress", "--config-file", "/etc/regulait/smokescreen.yaml", "--disable-acl-policy-action", "open", "--disable-acl-policy-action", "report"]
