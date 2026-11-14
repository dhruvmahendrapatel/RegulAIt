# RegulAIt Helm chart (`deploy/helm/regulait`)

Installs self-hosted RegulAIt on Kubernetes in `byoc` or `air_gapped` mode
([ADR-0304](../../../internal/decisions/0304-kubernetes-operator-and-helm-chart.md)). It is the plain-Helm path. The
operator in [`deploy/operator`](../../operator/README.md) is the declarative path, and this chart can also install it
(`operator.enabled`, off by default).

## What it installs

| Object | Notes |
|---|---|
| Migration Job (hook) | `pre-install,pre-upgrade`. Runs `node apps/gateway/dist/migrate-job.js` from the new image before the Deployment changes. A failed Job fails the release, so the old version keeps running. |
| NetworkPolicy (hook) | Default-deny ingress and egress for every pod of the release. It is created before the migration Job runs. Egress opens DNS to the cluster DNS pods (`k8s-app: kube-dns` in `kube-system`) only, `egress.databaseCIDRs` on 5432, `egress.allowedCIDRs`, and, in byoc with `egress.allowPublicEgress`, public addresses on 443 (with `169.254.0.0/16`, used for instance metadata, and the private ranges excluded). Ingress opens port 3000 to `ingressFrom` only. Helm keeps hook objects after uninstall, so delete it by hand if you remove the release. |
| Deployment | One replica with `Recreate` (one gateway at a time until P2). Non-root (uid 1000), read-only root filesystem, every capability dropped, RuntimeDefault seccomp, no service-account token. The image is pulled by digest. |
| Service, ServiceAccount | ClusterIP on 3000. The ServiceAccount does not mount a token. |
| PersistentVolumeClaim | Holds `/app/install-secrets` and `/app/audit-anchors`. It carries `helm.sh/resource-policy: keep`, because losing it loses the receipt and identity signing keys. |

## Install

```sh
kubectl create namespace regulait
kubectl label namespace regulait pod-security.kubernetes.io/enforce=restricted
kubectl -n regulait create secret generic regulait \
  --from-literal=data-key="$(openssl rand -hex 32)" \
  --from-literal=database-url='postgres://…?sslmode=verify-full' \
  --from-literal=bootstrap-token="$(openssl rand -hex 24)"
helm install regulait deploy/helm/regulait -n regulait -f my-values.yaml
```

Record the data key somewhere outside the cluster. Without it, a restore leaves every stored credential undecryptable
(ADR-0035).

`my-values.yaml` needs at least `mode`, `version`, `image.repository`, `image.digest`, `secrets.name`, the database CIDRs
and `ingressFrom`. See [`ci/byoc-values.yaml`](ci/byoc-values.yaml) and
[`ci/air-gapped-values.yaml`](ci/air-gapped-values.yaml).

## Secure defaults and refusals

`values.schema.json` refuses unknown keys, so no secret value can be passed as a value. It also refuses a tag in place
of a digest, `hosted` mode and a malformed version. The templates refuse:

- an image registry that is not in `image.allowedRegistries` (when the list is set);
- `air_gapped` without `image.allowedRegistries`, with `egress.allowPublicEgress`, or with any CIDR outside the
  private ranges;
- `operator.enabled` without an operator image digest.

Verify the update bundle (`scripts/verify-update-bundle.sh`) before you change `version` and `image.digest`. Helm
itself does not check the signature. The operator does, against the release keyring compiled into its binary. Until
the bundle schema carries image digests, the signature gates the version label, not the image that runs.

The migration hook Job carries the same pod and container security context as the gateway, and reads the database URL
only through `secretKeyRef`.

## Test

```sh
tests/render-test.sh /path/to/helm          # lint, render, pod checks, refusals, CRD/Role copies
KUBECONFORM=/path/to/kubeconform tests/render-test.sh /path/to/helm
```

The tests render templates only. Nothing is applied to a cluster.
