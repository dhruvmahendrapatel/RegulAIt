# Third-party components — the robot egress image (`engines/robot-egress`)

Open-source components the robot egress image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). ADR-0364 §7, §9. Verified 2026-11-19 against the Go
module proxy and checksum database, and by building the binary and reading its module list (`go version -m`).

**Admission status: NOT PUBLISHED.** The image is registered as unpublished in the engine-image pipeline.

**ADR-0176 exception: `github.com/hashicorp/golang-lru` v1.0.2 (MPL-2.0).** Admitted by the owner on 2026-11-22
(D-2026-11-22-07); the build's licence gate reads it from `licence-allow.json` ("accepted by owner").

- **Exact version:** v1.0.2, pinned by `portfilter/go.sum` (`h1:` hash checked against the Go checksum database,
  `-mod=readonly`, `go mod verify` in the build).
- **Condition:** shipped unmodified (the ADR-0187 decision 194 condition for MPL-2.0); the gate denies an MPL-2.0 row
  without `"condition": "unmodified"`.
- **Unmet requirement:** it is not ours to drop. `stripe/goproxy` imports it directly (its certificate cache), and
  Smokescreen links goproxy; no permissively licensed replacement can be linked without forking one of them, and
  Smokescreen is the only maintained proxy with the per-host CONNECT ACL the run needs (ADR-0364 §7).
- **Re-check:** when goproxy or Smokescreen drops the dependency, when a Smokescreen release changes the module set, or
  when a permissive drop-in appears.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `stripe/smokescreen` (Go, github.com/stripe/smokescreen, © Stripe) | `v0.1.0` (tag of commit `609eb893`, 2026-09-18; the latest tag on the module proxy on 2026-11-19), module hash `h1:E9Nd/WWMkMK3QAvCTlxiRBh1jTYyVy3BmXRci+zkXH8=` | MIT | The per-run CONNECT proxy, the sandbox's only route out (ADR-0364 §7): a hostname ACL, its own DNS resolution with a public-address check, deny ranges. One static binary (`CGO_ENABLED=0`) on a distroless static base. Built with Go 1.27.4 (`golang:1.27-trixie`, digest-pinned). |
| `gcr.io/distroless/static-debian12:nonroot` | digest `sha256:afa5c872…f7ab` (the operator image's pinned base) | Apache-2.0 (the image); Debian packages under their own licences (base-files, netbase, tzdata, ca-certificates) | The runtime base: no shell, no package manager, uid 65532. |
| RegulAIt's port filter (`portfilter/`, first-party) | this repository | proprietary (RegulAIt) | The binary's main module (`regulait.invalid/robot-egress`): smokescreen's own `main.go` plus a `PostDecisionRequestHandler` that refuses a destination port the run's targets do not name (ADR-0176 exception: smokescreen has no port setting), and the front CONNECT filter (`front.go`, Go standard library only) that the sandbox reaches instead of Smokescreen (D-2026-11-22-07). Links no module beyond smokescreen's own set. |
| Go modules linked into smokescreen v0.1.0 (22) | `portfilter/go.sum` (smokescreen's set, with four modules raised to their fixed releases by `portfilter/go.mod`) (logrus v1.9.3, x/net v0.62.0, x/sys v0.49.0, x/text v0.43.0: HIGH CVEs in the pinned versions), each checked against the Go checksum database; then `-mod=readonly`, `go mod verify` | MIT: datadog-go, go-proxyproto, perks, versioninfo, xxhash, go-cache, xid, logrus, urfave/cli.v1. Apache-2.0: golang_protobuf_extensions, prometheus client_golang, client_model, common, procfs, yaml.v2. BSD-3-Clause: golang/protobuf, stripe/goproxy, golang.org/x/net, x/sys, x/text, google.golang.org/protobuf. **MPL-2.0: hashicorp/golang-lru v1.0.2 (ADR-0176 exception, above).** | Each one judged in the build by `licence-gate.mjs` against `licence-readings.json` (the licence a person read in the module's licence file, pinned to the version and the file's sha256). |
