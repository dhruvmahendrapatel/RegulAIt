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
3. It applies the ServiceAccounts (the gateway's and the backup CronJob's own, neither with a token), the Service, four
   NetworkPolicies (a namespace-wide deny-all baseline; the gateway's; one for the migration Job and backup pods, which
   reach only DNS and the database; and the backup pods' object-store policy, which opens nothing without
   `backup.s3`), the install-secrets claim
   (never owned, so deleting the CR keeps the keys) and the backup CronJob. A changed owned object is put back, counted
   in `status.driftCorrections` and reported with a `DriftCorrected` event.
4. It runs `node apps/gateway/dist/migrate-job.js` as a Job from the new image. The Deployment moves to that image only
   after the Job succeeds. A failed Job leaves the installed version running.
5. It records `status.installedVersion` once the Deployment is available.

Conditions: `SpecValid`, `BundleVerified`, `EgressRestricted`, `Migrated`, `BackupConfigured`, `Available`, `Ready`.
`StorageClassNamed` is informational and not part of `Ready`. It is `False`, with a `Warning` event on every
reconcile, when the operator's install-secrets claim uses the cluster's default StorageClass (`DefaultStorageClass`)
or was created on a class other than the one now named (`ClaimClassDiffers`). The claim holds signing keys
unencrypted.

The other informational conditions (none of them hold `Ready`):

| Condition | Meaning |
|---|---|
| `PublicEgress` | `True` (`PublicEgressOpen`), with a `Warning` event on every reconcile, while `egress.allowPublicEgress` or a non-private `allowedCIDRs`/`databaseCIDRs` entry is in use. |
| `ImageProvenance` | `False` (`DigestNotSigned`) until a bundle schema signs the image digest. The message names what limits the digest instead: `image.allowedRegistries` and who may edit the resource. An empty allow-list also raises a `NoRegistryAllowList` warning. |
| `ReleaseKeyring` | `False` (`DevelopmentKeysOnly`) while every compiled-in key is a development key (`*-dev-*`). |

Condition and event messages are cut at 1024 bytes, because manifest strings are untrusted.

## Security defaults

- Every pod runs non-root with a read-only root filesystem, every capability dropped, `RuntimeDefault` seccomp, no
  service-account token and resource limits. The namespace in `config/manager` enforces Pod Security `restricted`.
- Images are referenced by digest only.
- The operator watches one namespace (`WATCH_NAMESPACE`, required) and holds a namespaced Role, never a ClusterRole;
  only the CRD is cluster-scoped.
- The operator holds **no direct Secret permission**; the gateway reads Secrets through `secretKeyRef`. Because it can
  create pods, its workload rights still imply read access to the Secrets in the one namespace it manages.
- Until the bundle schema carries image digests (ADR-0304 owner question 1), the signature gates the version label,
  not the image that runs. `allowedRegistries` and the namespace's RBAC are the controls for the digest. Until then,
  **the right to edit a `RegulaitInstallation` is the right to deploy any image from an allowed registry with the
  gateway's database URL and data key**: grant it as such. `Ready` and `ImageProvenance` say this in their messages.
- Egress (ADR-0180): no list may overlap a link-local range or a cloud metadata address (`169.254.0.0/16`,
  `fe80::/10`, `fd00:ec2::254`), in any mode. `egress.dns.cidrs` takes private ranges and single link-local
  addresses only (NodeLocal DNSCache), since it opens port 53 alone. `air_gapped` takes private ranges only. Public
  egress in `byoc` is allowed but reported (`PublicEgress`).
- Downgrade protection compares against `status.installedVersion`. Anyone who can patch
  `regulaitinstallations/status` can clear it, so that right belongs to the operator alone.
- Metrics are off unless `--metrics-bind-address` is set, and then they are served over HTTPS behind authentication and
  authorization. Turning them on needs a ClusterRole for `tokenreviews` and `subjectaccessreviews`, which is not shipped.
- One gateway replica until P2 (HA) lands; the schema refuses more.

## The Helm path's bundle check

`manager verify-bundle --manifest <file> --signature <file> --version <v> [--installed-version <v>]` runs the same
verification with the same compiled-in keyring and no network. The Helm chart's migration hook runs it as an init
container, so a plain-Helm install refuses an unsigned or downgraded version too. Exit codes: 0 verified, 1 refused,
2 usage.

## Backups to S3 in the customer's account (ADR-0305)

`spec.backup.s3` sends each dump to a bucket in the customer's own AWS account instead of a claim:

```yaml
backup:
  image: { repository: registry.internal.example/postgres, digest: "sha256:…" }   # pg_dump
  s3:
    bucket: example-regulait-backups
    region: eu-west-1
    prefix: regulait/
    kmsKeyARN: arn:aws:kms:eu-west-1:111122223333:key/…      # customer-managed key; SSE-KMS on every object
    expectedBucketOwner: "111122223333"                       # an upload to anyone else's bucket fails
    uploaderImage: { repository: registry.internal.example/aws-cli, digest: "sha256:…" }
    roleARN: arn:aws:iam::111122223333:role/regulait-backup   # IRSA; omit with EKS Pod Identity
    podIdentity: false
    egressCIDRs: [10.20.30.0/24]                              # the S3 and STS VPC endpoints, 443 only
```

- `pg_dump` runs as an init container into a pod-local `emptyDir`; the uploader (`aws s3 cp --sse aws:kms
  --sse-kms-key-id … --expected-bucket-owner …`) never sees the database URL. No AWS key is in the spec or a Secret:
  the pod runs as `<name>-backup`, and its credentials come from IRSA (`roleARN` becomes the
  `eks.amazonaws.com/role-arn` annotation) or an EKS Pod Identity association on that ServiceAccount.
- The role needs `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>*` and `kms:GenerateDataKey` on the key. It needs no
  read, list or delete: a compromised pod cannot read or remove earlier backups.
- Versioning, retention and lifecycle are the bucket's own rules (the BYOC Terraform module sets them);
  `retentionDays` applies to a claim only.
- `egressCIDRs` follow the other egress lists: no link-local or metadata address, private ranges only in `air_gapped`,
  and a public range is reported by `PublicEgress`. `podIdentity: true` opens TCP 80 to the Pod Identity agent
  (169.254.170.23, fd00:ec2::23) for the backup pods only, and is reported by `PublicEgress` on every reconcile.
- The CRD refuses a claim and a bucket together.

## At rest

The install-secrets claim holds signing keys unencrypted, and the backup claim holds `pg_dump` output in which only
the data-key-encrypted columns are ciphertext (ADR-0035). Name an encrypted StorageClass for both
(`spec.installSecretsStorageClassName`, and the class of the backup claim you create). With `backup.s3` the dump is
on the pod's `emptyDir` only until the upload ends, and SSE-KMS with the customer's key encrypts it in the bucket.

## Develop

```sh
make generate manifests   # controller-gen v0.23.0: deep copy, CRD, Role
make test                 # gofmt, vet, unit tests and envtest (a local kube-apiserver and etcd, 1.37.0), with -race
make licences             # every linked module is in THIRD_PARTY.md
```

The tests never contact a real cluster. Do not apply these manifests to a real cluster from a development session.
