# Third-party components — the robot egress image (`engines/robot-egress`)

Open-source components the robot egress image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). ADR-0364 §7, §9. Verified 2026-11-19 against the Go
module proxy and checksum database, and by building the binary and reading its module list (`go version -m`).

**Admission status: NOT PUBLISHED, and one licence pending an owner decision.** The image is registered as unpublished in
the engine-image pipeline. `github.com/hashicorp/golang-lru` (MPL-2.0) is linked into the binary; its row in
`licence-allow.json` reuses ADR-0187 decision 194 ("MPL-2.0 only while unmodified") and is marked *owner to confirm*, so
the build passes but the image is not admissible until the owner decides.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `stripe/smokescreen` (Go, github.com/stripe/smokescreen, © Stripe) | `v0.1.0` (tag of commit `609eb893`, 2026-09-18; the latest tag on the module proxy on 2026-11-19), module hash `h1:E9Nd/WWMkMK3QAvCTlxiRBh1jTYyVy3BmXRci+zkXH8=` | MIT | The per-run CONNECT proxy, the sandbox's only route out (ADR-0364 §7): a hostname ACL, its own DNS resolution with a public-address check, deny ranges. One static binary (`CGO_ENABLED=0`) on a distroless static base. Built with Go 1.27.4 (`golang:1.27-trixie`, digest-pinned). |
| `gcr.io/distroless/static-debian12:nonroot` | digest `sha256:afa5c872…f7ab` (the operator image's pinned base) | Apache-2.0 (the image); Debian packages under their own licences (base-files, netbase, tzdata, ca-certificates) | The runtime base: no shell, no package manager, uid 65532. |
| Go modules linked into smokescreen v0.1.0 (22) | exactly smokescreen's `go.sum` (`-mod=readonly`, `go mod verify`) | MIT: datadog-go, go-proxyproto, perks, versioninfo, xxhash, go-cache, xid, logrus, urfave/cli.v1. Apache-2.0: golang_protobuf_extensions, prometheus client_golang, client_model, common, procfs, yaml.v2. BSD-3-Clause: golang/protobuf, stripe/goproxy, golang.org/x/net, x/sys, x/text, google.golang.org/protobuf. **MPL-2.0: hashicorp/golang-lru v1.0.2 (pending, above).** | Each one judged in the build by `licence-gate.mjs` against `licence-readings.json` (the licence a person read in the module's licence file, pinned to the version and the file's sha256). |
