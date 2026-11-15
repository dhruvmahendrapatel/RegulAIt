# Third-party components — RegulAIt operator (`deploy/operator`)

ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained (a release in about the last 12 months); pinned;
works air-gapped. Go modules are pinned by `go.mod` and hashed by `go.sum`; nothing is fetched at run time.
`scripts/check-licences.sh` fails CI when the binary links a module@version that is not in the first table.
Searched and checked 2026-11-14 against `proxy.golang.org` (release dates) and each module's licence file.

**Older transitive modules.** Rows marked *transitive* are pulled in by `k8s.io/client-go` and
`sigs.k8s.io/controller-runtime` at the versions the Kubernetes project pins and tests; some have had no release in
over 12 months (for example `github.com/davecgh/go-spew`, `gopkg.in/inf.v0`). We do not choose them and cannot
replace them without forking client-go, so the exception (ADR-0176 item 4) is recorded here and re-checked when
controller-runtime moves. None has an open advisory (`govulncheck` runs in CI).

## Linked into the operator binary

| Module | Version | Licence | Used for, and why |
|---|---|---|---|
| `cel.dev/expr` | `v0.25.2` | Apache-2.0 | *transitive* (release 2026-03-12) |
| `github.com/antlr4-go/antlr/v4` | `v4.13.1` | BSD-3-Clause | *transitive* (release 2024-05-15) |
| `github.com/beorn7/perks` | `v1.0.1` | MIT | *transitive* (release 2019-07-31) |
| `github.com/blang/semver/v4` | `v4.0.0` | MIT | *transitive* (release 2020-05-24) |
| `github.com/cenkalti/backoff/v5` | `v5.0.3` | MIT | *transitive* (release 2025-07-23) |
| `github.com/cespare/xxhash/v2` | `v2.3.0` | MIT | *transitive* (release 2024-04-04) |
| `github.com/davecgh/go-spew` | `v1.1.2-0.20180830191138-d8f796af33cc` | ISC | *transitive* (release 2018-08-30) |
| `github.com/emicklei/go-restful/v3` | `v3.13.0` | MIT | *transitive* (release 2025-08-14) |
| `github.com/evanphx/json-patch/v5` | `v5.9.11` | BSD-3-Clause | *transitive* (release 2025-01-28) |
| `github.com/felixge/httpsnoop` | `v1.0.4` | MIT | *transitive* (release 2023-03-12) |
| `github.com/fsnotify/fsnotify` | `v1.9.0` | BSD-3-Clause | *transitive* (release 2025-04-04) |
| `github.com/fxamacker/cbor/v2` | `v2.9.1` | MIT | *transitive* (release 2026-03-30) |
| `github.com/go-logr/logr` | `v1.4.4` | Apache-2.0 | *transitive* (release 2026-07-20) |
| `github.com/go-logr/stdr` | `v1.2.2` | Apache-2.0 | *transitive* (release 2021-12-14) |
| `github.com/go-logr/zapr` | `v1.3.0` | Apache-2.0 | *transitive* (release 2023-11-03) |
| `github.com/go-openapi/jsonpointer` | `v1.0.0` | Apache-2.0 | *transitive* (release 2026-07-07) |
| `github.com/go-openapi/jsonreference` | `v1.0.0` | Apache-2.0 | *transitive* (release 2026-07-07) |
| `github.com/go-openapi/swag/cmdutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/conv` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/fileutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/jsonutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/loading` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/mangling` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/netutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/pools` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/stringutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/typeutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag/yamlutils` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/go-openapi/swag` | `v0.27.1` | Apache-2.0 | *transitive* (release 2026-07-19) |
| `github.com/google/cel-go` | `v0.30.0` | Apache-2.0 | *transitive* (release 2026-07-25) |
| `github.com/google/gnostic-models` | `v0.7.0` | Apache-2.0 | *transitive* (release 2025-06-26) |
| `github.com/google/uuid` | `v1.6.0` | BSD-3-Clause | *transitive* (release 2024-01-23) |
| `github.com/grpc-ecosystem/grpc-gateway/v2` | `v2.29.0` | BSD-3-Clause | *transitive* (release 2026-04-15) |
| `github.com/json-iterator/go` | `v1.1.12` | MIT | *transitive* (release 2021-09-11) |
| `github.com/modern-go/concurrent` | `v0.0.0-20180306012644-bacd9c7ef1dd` | Apache-2.0 | *transitive* (release 2018-03-06) |
| `github.com/modern-go/reflect2` | `v1.0.3-0.20250322232337-35a7c28c31ee` | Apache-2.0 | *transitive* (release 2025-03-22) |
| `github.com/munnerz/goautoneg` | `v0.0.0-20191010083416-a7dc8b61c822` | BSD-3-Clause | *transitive* (release 2019-10-10) |
| `github.com/pmezard/go-difflib` | `v1.0.1-0.20181226105442-5d4384ee4fb2` | BSD-3-Clause | *transitive* (release 2018-12-26) |
| `github.com/prometheus/client_golang` | `v1.24.0` | Apache-2.0 | *transitive* (release 2026-07-20) |
| `github.com/prometheus/client_model` | `v0.6.2` | Apache-2.0 | *transitive* (release 2025-04-11) |
| `github.com/prometheus/common` | `v0.70.0` | Apache-2.0 | *transitive* (release 2026-07-10) |
| `github.com/prometheus/procfs` | `v0.21.1` | Apache-2.0 | *transitive* (release 2026-06-30) |
| `github.com/spf13/cobra` | `v1.10.2` | Apache-2.0 | *transitive* (release 2025-12-03) |
| `github.com/spf13/pflag` | `v1.0.10` | BSD-3-Clause | *transitive* (release 2025-09-02) |
| `github.com/x448/float16` | `v0.8.4` | MIT | *transitive* (release 2020-01-17) |
| `go.opentelemetry.io/auto/sdk` | `v1.2.1` | Apache-2.0 | *transitive* (release 2025-09-15) |
| `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` | `v0.69.0` | Apache-2.0 | *transitive* (release 2026-05-28) |
| `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc` | `v1.45.0` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `go.opentelemetry.io/otel/exporters/otlp/otlptrace` | `v1.45.0` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `go.opentelemetry.io/otel/metric` | `v1.45.0` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `go.opentelemetry.io/otel/sdk` | `v1.45.0` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `go.opentelemetry.io/otel/trace` | `v1.45.0` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `go.opentelemetry.io/otel` | `v1.45.0` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `go.opentelemetry.io/proto/otlp` | `v1.11.0` | Apache-2.0 | *transitive* (release 2026-07-22) |
| `go.uber.org/multierr` | `v1.11.0` | MIT | *transitive* (release 2023-03-29) |
| `go.uber.org/zap` | `v1.27.1` | MIT | *transitive* (release 2025-11-19) |
| `go.yaml.in/yaml/v2` | `v2.4.4` | Apache-2.0 | *transitive* (release 2026-03-06) |
| `go.yaml.in/yaml/v3` | `v3.0.4` | Apache-2.0 | *transitive* (release 2025-06-29) |
| `golang.org/x/exp` | `v0.0.0-20260410095643-746e56fc9e2f` | BSD-3-Clause | *transitive* (release 2026-04-10) |
| `golang.org/x/mod` | `v0.43.0` | BSD-3-Clause | `semver.Compare` for the downgrade and minimum-version checks (no hand-written version compare). (release 2026-11-09) |
| `golang.org/x/net` | `v0.62.0` | BSD-3-Clause | *transitive* (release 2026-10-27) |
| `golang.org/x/oauth2` | `v0.36.0` | BSD-3-Clause | *transitive* (release 2026-02-11) |
| `golang.org/x/sync` | `v0.24.0` | BSD-3-Clause | *transitive* (release 2026-09-23) |
| `golang.org/x/sys` | `v0.49.0` | BSD-3-Clause | *transitive* (release 2026-10-06) |
| `golang.org/x/term` | `v0.47.0` | BSD-3-Clause | *transitive* (release 2026-10-09) |
| `golang.org/x/text` | `v0.43.0` | BSD-3-Clause | *transitive* (release 2026-10-09) |
| `golang.org/x/time` | `v0.15.0` | BSD-3-Clause | *transitive* (release 2026-02-11) |
| `gomodules.xyz/jsonpatch/v2` | `v2.4.0` | Apache-2.0 | *transitive* (release 2023-08-14) |
| `google.golang.org/genproto/googleapis/api` | `v0.0.0-20260803160001-6ac0973c030d` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `google.golang.org/genproto/googleapis/rpc` | `v0.0.0-20260803160001-6ac0973c030d` | Apache-2.0 | *transitive* (release 2026-08-03) |
| `google.golang.org/grpc` | `v1.83.2` | Apache-2.0 | *transitive* (release 2026-08-25) |
| `google.golang.org/protobuf` | `v1.36.12-0.20260120151049-f2248ac996af` | BSD-3-Clause | *transitive* (release 2026-01-20) |
| `gopkg.in/evanphx/json-patch.v4` | `v4.13.0` | BSD-3-Clause | *transitive* (release 2025-01-28) |
| `gopkg.in/inf.v0` | `v0.9.1` | BSD-3-Clause | *transitive* (release 2018-03-26) |
| `k8s.io/api` | `v0.37.0` | Apache-2.0 | Typed Kubernetes objects (Deployment, Job, CronJob, NetworkPolicy, ...). (release 2026-08-26) |
| `k8s.io/apiextensions-apiserver` | `v0.37.0` | Apache-2.0 | *transitive* (release 2026-08-26) |
| `k8s.io/apimachinery` | `v0.37.0` | Apache-2.0 | Object metadata, conditions, unstructured conversion. (release 2026-08-26) |
| `k8s.io/apiserver` | `v0.37.0` | Apache-2.0 | *transitive* (release 2026-08-26) |
| `k8s.io/client-go` | `v0.37.0` | Apache-2.0 | API client, event recorder, retry. (release 2026-08-26) |
| `k8s.io/component-base` | `v0.37.0` | Apache-2.0 | *transitive* (release 2026-08-26) |
| `k8s.io/klog/v2` | `v2.140.0` | Apache-2.0 | *transitive* (release 2026-03-03) |
| `k8s.io/kube-openapi` | `v0.0.0-20260721132016-d427ff9ee9ad` | Apache-2.0 | *transitive* (release 2026-07-21) |
| `k8s.io/streaming` | `v0.37.0` | Apache-2.0 | *transitive* (release 2026-08-09) |
| `k8s.io/utils` | `v0.0.0-20260626114624-be93311217bd` | Apache-2.0 | `ptr.To` helpers. (release 2026-06-26) |
| `sigs.k8s.io/apiserver-network-proxy/konnectivity-client` | `v0.36.0` | Apache-2.0 | *transitive* (release 2026-06-03) |
| `sigs.k8s.io/controller-runtime` | `v0.25.2` | Apache-2.0 | The operator framework: manager, cache, reconcile loop, server-side apply, leader election (ADR-0304 search: the Kubebuilder standard). (release 2026-09-30) |
| `sigs.k8s.io/json` | `v0.0.0-20250730193827-2d320260d730` | Apache-2.0 | *transitive* (release 2025-07-30) |
| `sigs.k8s.io/randfill` | `v1.0.0` | Apache-2.0 | *transitive* (release 2025-03-04) |
| `sigs.k8s.io/structured-merge-diff/v6` | `v6.4.2` | Apache-2.0 | *transitive* (release 2026-07-07) |
| `sigs.k8s.io/yaml` | `v1.6.0` | Apache-2.0 | *transitive* (release 2025-07-24) |

## Build and test only (not linked)

| Module | Version | Licence | Used for |
|---|---|---|---|
| `sigs.k8s.io/controller-tools` (`controller-gen`) | `v0.23.0` | Apache-2.0 | Generates the CRD, the Role and the deep-copy code; the output is committed. |
| `sigs.k8s.io/controller-runtime/tools/setup-envtest` | `v0.25.2` | Apache-2.0 | Downloads the envtest kube-apiserver and etcd (1.37.0) for `make test`. |
| `golang.org/x/vuln` (`govulncheck`) | `v1.9.0` | BSD-3-Clause | CI vulnerability scan of the module graph. |

## Container base images

| Image | Pinned digest | Licence | Used for |
|---|---|---|---|
| `golang:1.26.11-trixie` | `sha256:fa340cb59ebeb1d53ac1cccfc334201d938fe5f3458003cccb767096d8e032b8` | BSD-3-Clause (Go) | Build stage only. |
| `gcr.io/distroless/static-debian12:nonroot` | `sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab` | Apache-2.0 | Runtime: no shell, no package manager, uid 65532. |
