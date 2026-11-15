# Third-party components — RegulAIt Helm chart (`deploy/helm/regulait`)

The chart ships no third-party code: it is templates over the RegulAIt images. Tools used only to test it (ADR-0176:
licence checked, pinned, nothing fetched when the chart is installed):

| Tool | Version | Licence | Used for |
|---|---|---|---|
| Helm | `v3.22.1` (tarball SHA-256 pinned in `.github/workflows/helm-chart.yml`) | Apache-2.0 | `helm lint` and `helm template` in CI |
| `github.com/yannh/kubeconform` | `v0.8.0` (2026-06-04) | Apache-2.0 | Schema validation of the rendered manifests in CI |
| `github.com/sigstore/cosign` | `v3.1.3` (binary SHA-256 pinned in `.github/workflows/helm-chart.yml`) | Apache-2.0 | Keyless signing and verification of the published chart in CI |
| `registry` (CNCF Distribution) | `registry:3` by digest in `.github/workflows/helm-chart.yml` | Apache-2.0 | Local OCI registry for the push/pull round trip in CI |
