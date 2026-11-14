# RegulAIt Helm chart (`deploy/helm/regulait`)

Installs self-hosted RegulAIt on Kubernetes in `byoc` or `air_gapped` mode
([ADR-0304](../../../internal/decisions/0304-kubernetes-operator-and-helm-chart.md)). It is the plain-Helm path. The
operator in [`deploy/operator`](../../operator/README.md) is the declarative path, and this chart can also install it
(`operator.enabled`, off by default).

## What it installs

| Object | Notes |
|---|---|
| Migration Job (hook) | `pre-install,pre-upgrade`, weight 0. An init container first runs the operator binary's `verify-bundle` against the signed manifest in `bundle.configMapName`, using the same compiled-in release keyring. It refuses an unsigned or tampered manifest, a version other than `version`, and a downgrade from the installed version: `bundle.installedVersion` when set, else the running Deployment's version label read with `lookup`. An upgrade where neither is available (`helm template --is-upgrade`, `--dry-run`, GitOps renderers) is refused at render time, so the downgrade check is never skipped. Then `node apps/gateway/dist/migrate-job.js` runs from the new image. A failed check or migration fails the release, so the old version keeps running. |
| NetworkPolicies | Ordinary release resources, so an upgrade never removes them from the running gateway and `helm uninstall` deletes them. `<release>-baseline` denies all ingress and egress for every pod in the namespace. `<release>-gateway` opens DNS, `egress.databaseCIDRs` on 5432, `egress.allowedCIDRs`, and, in byoc with `egress.allowPublicEgress`, public 443 (excluding `169.254.0.0/16` and the private ranges); ingress is port 3000 from `ingressFrom` only. `<release>-database-clients` (the migration Job) opens DNS and the database only. DNS defaults to the `k8s-app: kube-dns` pods. Set `egress.dns` for NodeLocal DNSCache or a renamed CoreDNS. |
| NetworkPolicy (hook) | `<release>-hook-database-clients`, the same rules as `<release>-database-clients`, at hook weight -10. Hooks run before release resources exist, so it covers the migration Job on a first install. It is deleted when the hook phase succeeds. |
| Deployment | One replica with `Recreate` (one gateway at a time until P2). Non-root (uid 1000), read-only root filesystem, every capability dropped, RuntimeDefault seccomp, no service-account token. The image is pulled by digest. |
| Service, ServiceAccount | ClusterIP on 3000. The ServiceAccount does not mount a token. |
| PersistentVolumeClaim | Holds `/app/install-secrets` and `/app/audit-anchors`. It carries `helm.sh/resource-policy: keep`, because losing it loses the receipt and identity signing keys. |

## Install

```sh
kubectl create namespace regulait
kubectl label namespace regulait pod-security.kubernetes.io/enforce=restricted
kubectl -n regulait create configmap regulait-bundle-1.0.0 \
  --from-file=manifest.json --from-file=manifest.json.sig      # from the signed update bundle, unchanged
kubectl -n regulait create secret generic regulait \
  --from-literal=data-key="$(openssl rand -hex 32)" \
  --from-literal=database-url='postgres://…?sslmode=verify-full' \
  --from-literal=bootstrap-token="$(openssl rand -hex 24)"
helm install regulait deploy/helm/regulait -n regulait -f my-values.yaml
```

Record the data key somewhere outside the cluster. Without it, a restore leaves every stored credential undecryptable
(ADR-0035).

`my-values.yaml` needs at least `mode`, `version`, `image.repository`, `image.digest`, `secrets.name`,
`bundle.configMapName`, `operator.image` (by digest; the hook's verifier), `installSecrets.storageClassName` (an
encrypted class: the claim holds signing keys unencrypted), the database CIDRs
and `ingressFrom`. See [`ci/byoc-values.yaml`](ci/byoc-values.yaml) and
[`ci/air-gapped-values.yaml`](ci/air-gapped-values.yaml).

## Secure defaults and refusals

`values.schema.json` refuses unknown keys, so no secret value can be passed as a value. It also refuses a tag in place
of a digest, `hosted` mode and a malformed version. The templates refuse:

- an image registry that is not in `image.allowedRegistries` (when the list is set);
- `air_gapped` without `image.allowedRegistries`, with `egress.allowPublicEgress`, or with any CIDR outside the
  private ranges;
- `operator.enabled` without an operator image digest.

The migration hook verifies the signed manifest before every install and upgrade, with the release keyring compiled
into the operator binary. Until the bundle schema carries image digests, the signature gates the version label, not the
image that runs: `image.allowedRegistries` and the namespace's RBAC are the controls for the digest.

The migration hook Job carries the same pod and container security context as the gateway, and reads the database URL
only through `secretKeyRef`.

## Test

```sh
tests/render-test.sh /path/to/helm          # lint, render, pod checks, refusals, CRD/Role copies
KUBECONFORM=/path/to/kubeconform tests/render-test.sh /path/to/helm
```

The tests render templates only. Nothing is applied to a cluster.
