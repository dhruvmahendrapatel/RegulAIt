# RegulAIt operator (`deploy/operator`)

A Kubernetes operator for self-installed RegulAIt in `byoc` and `air_gapped` mode
([ADR-0304](../../internal/decisions/0304-kubernetes-operator-and-helm-chart.md)). It is built with Kubebuilder's layout
on `sigs.k8s.io/controller-runtime`.

One custom resource, `RegulaitInstallation` (`deploy.regulait.ai/v1alpha1`), describes one installation: the version,
the mode, the gateway image by digest, the signed update-bundle manifest, Secret references for the
data key, database URL and bootstrap token, the backup policy, and the egress posture. See
[`config/samples/regulaitinstallation.yaml`](config/samples/regulaitinstallation.yaml).

## What a reconcile does

1. It validates what the schema cannot express: the registry is in `allowedRegistries`, and `air_gapped` allows
   only private CIDRs and no public egress.
2. It verifies `manifest.json` against `manifest.json.sig` under a release key **compiled into the operator**
   (`internal/bundle/keys/`, kept equal to `infra/release-keys/` by a test). A key in a ConfigMap is trusted only
   if the spec names an extra keyring (`extraKeyringConfigMapRef`). That opt-in is reported on every reconcile, and it
   can add key ids but never replace a compiled-in one. The rules match
   `scripts/verify-update-bundle.sh`: schema, product, key id shape, signature, `version == spec.version`, no downgrade,
   and `minInstalledVersion`. An unverified version is never rolled out.
3. It applies the ServiceAccount (no token), the Service, the default-deny NetworkPolicy, the install-secrets claim
   (never owned, so deleting the CR keeps the keys) and the backup CronJob. A changed owned object is put back, counted
   in `status.driftCorrections` and reported with a `DriftCorrected` event.
4. It runs `node apps/gateway/dist/migrate-job.js` as a Job from the new image. The Deployment moves to that image only
   after the Job succeeds. A failed Job leaves the installed version running.
5. It records `status.installedVersion` once the Deployment is available.

Conditions: `SpecValid`, `BundleVerified`, `EgressRestricted`, `Migrated`, `BackupConfigured`, `Available`, `Ready`.

## Security defaults

- Every pod runs non-root with a read-only root filesystem, every capability dropped, `RuntimeDefault` seccomp, no
  service-account token and resource limits. The namespace in `config/manager` enforces Pod Security `restricted`.
- Images are referenced by digest only.
- The operator watches one namespace (`WATCH_NAMESPACE`, required) and holds a namespaced Role, never a ClusterRole;
  only the CRD is cluster-scoped.
- The operator holds **no direct Secret permission**; the gateway reads Secrets through `secretKeyRef`. Because it can
  create pods, its workload rights still imply read access to the Secrets in the one namespace it manages.
- Until the bundle schema carries image digests (ADR-0304 owner question 1), the signature gates the version label,
  not the image that runs. `allowedRegistries` and the namespace's RBAC are the controls for the digest.
- Metrics are off unless `--metrics-bind-address` is set, and then they are served over HTTPS behind authentication and
  authorization. Turning them on needs a ClusterRole for `tokenreviews` and `subjectaccessreviews`, which is not shipped.
- One gateway replica until P2 (HA) lands; the schema refuses more.

## Develop

```sh
make generate manifests   # controller-gen v0.23.0: deep copy, CRD, Role
make test                 # gofmt, vet, unit tests and envtest (a local kube-apiserver and etcd, 1.37.0), with -race
make licences             # every linked module is in THIRD_PARTY.md
```

The tests never contact a real cluster. Do not apply these manifests to a real cluster from a development session.
