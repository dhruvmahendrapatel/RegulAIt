# ADR-0304: A Kubernetes operator and a Helm chart for self-installed RegulAIt (BYOC and air-gapped)

- **Status**: Accepted (lane L12 brief, 2026-11-14: the queue is built in parallel; owner questions are listed below)
- **Date**: 2026-11-14
- **Index**: **Self-install on Kubernetes (P22, the Helm row): a controller-runtime operator with a `RegulaitInstallation` CRD (version, mode, data-key Secret reference, backup policy, egress posture) that rolls out only a version whose signed update-bundle manifest verifies (ADR-0041), plus a Helm chart and a migration Job.** Kubebuilder layout and controller-runtime (Apache-2.0). Secure defaults: non-root, read-only root filesystem, every capability dropped, NetworkPolicy default-deny, images by digest only, no secret values in the CR or in Helm values, a namespaced Role with no direct Secret permission, and the release keyring compiled into the operator. Air-gapped refuses a public egress range and a registry outside the customer's.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P22 and the "Helm chart / k8s install for RegulAIt itself" row
- **Built in**: lane L12, three PRs (this ADR; the operator in `deploy/operator/`; the chart in `deploy/helm/regulait/`)
- **Migration**: none (no database change; the migration Job runs the existing migrations)
- **Related**: [ADR-0041](0041-byoc-primary-motion.md) (BYOC primary motion, signed update bundles),
  [ADR-0062](0062-mode-scoped-egress.md) (mode-scoped egress), ADR-0013 (Compose on one host), ADR-0035 (nightly
  `pg_dump`), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (security checklist)

## Context

Pillar 3's BYOC and air-gapped modes ship today as `scripts/install.sh` over Docker Compose on one host (ADR-0013,
ADR-0041 amendment). A customer that runs Kubernetes has no declarative, in-cluster way to install, upgrade and keep
RegulAIt converged. PENDING P22 asks for an operator with CRDs for the version, the mode (`byoc` / `air_gapped`), the
data-key reference, the backup policy and the egress posture, reconciling toward the signed update bundle and reporting
drift. The PENDING infrastructure table separately asks for a Helm chart, manifests and a migration Job.

Facts that shape the design, read from the code:

- The gateway image (`Dockerfile`) runs as the `node` user (uid 1000) from `/app`, listens on 3000, answers
  `GET /health`, and starts with `apps/gateway/docker-start.sh`.
- `startGateway` (`apps/gateway/src/boot.ts`) runs `runMigrations` on every boot. Two replicas booting at once both
  migrate; nothing in the boot path is a "migrate only" step.
- First boot writes install-generated signing keys under `REGULAIT_INSTALL_SECRETS_DIR` (`/app/install-secrets`). A pod
  that loses that directory on restart loses its receipt and identity keys.
- The update bundle (`scripts/build-update-bundle.sh`, schema `regulait.update-bundle/1`) is `manifest.json` plus a
  detached Ed25519 signature over the manifest bytes, verified offline against a pinned keyring
  (`infra/release-keys/*.pub`) by `scripts/verify-update-bundle.sh`. The verifier refuses an unknown key id, a bad
  signature, a key id with path characters and a downgrade. The manifest names files and their SHA-256; it does not
  name an image digest.
- ADR-0062: `REGULAIT_DEPLOY_MODE` (`hosted` / `byoc` / `air_gapped`) decides the gateway's egress posture, and a
  malformed value refuses the boot.

## Open-source search (ADR-0176)

| Need | Candidate | Result |
|---|---|---|
| Operator framework | Kubebuilder v4 layout + `sigs.k8s.io/controller-runtime` (Apache-2.0) | **Used.** The de-facto standard; the reference in P22 (`gravitee-io/gravitee-kubernetes-operator`, Apache-2.0) is built on it. |
| | Operator SDK (Apache-2.0) | Not used: it wraps Kubebuilder for Go operators and adds OLM packaging we do not need yet. |
| | Kopf (Python), Java Operator SDK | Not used: a second runtime in the image for no gain; the endpoint agent already sets Go as our in-cluster language. |
| CRD and RBAC generation | `sigs.k8s.io/controller-tools` (`controller-gen`, Apache-2.0) | **Used** at development time; the generated YAML is committed. |
| Tests | `controller-runtime/pkg/envtest` (real kube-apiserver + etcd) and the fake client | **Used.** No cluster is ever contacted. |
| Signature verification | Go standard library `crypto/ed25519`, `crypto/x509`, `crypto/ecdsa`, `crypto/rsa` | **Used.** Same algorithms as the shell verifier (Ed25519, with the RSA/EC SHA-256 fallback). No hand-written crypto. |
| Chart packaging | Helm 3 (Apache-2.0) chart format | **Used.** The chart has no dependencies and no template library. |
| Chart validation | `helm lint` and `helm template` in CI, plus kubeconform (Apache-2.0) | **Used** in CI only. |

## Decision

### 1. One custom resource: `RegulaitInstallation` (`deploy.regulait.ai/v1alpha1`, namespaced)

| Field | Meaning | Default and validation |
|---|---|---|
| `spec.version` | The RegulAIt version to run | Required, semver. Must equal the verified manifest's `version`. |
| `spec.mode` | `byoc` or `air_gapped` | Required, enum. `hosted` is not accepted: it is our own SaaS shape, not a self-install. Passed to the gateway as `REGULAIT_DEPLOY_MODE`. |
| `spec.image.repository`, `spec.image.digest` | The gateway image | Both required. The digest must be `sha256:` + 64 hex; a tag is never accepted. The pod pulls `repository@digest`. |
| `spec.image.allowedRegistries` | Registries the repository may live in | Required in `air_gapped` (at least one); the repository's registry host must be in it. |
| `spec.updateBundle.manifestConfigMapRef` | ConfigMap holding `manifest.json` and `manifest.json.sig` | Required. |
| `spec.updateBundle.extraKeyringConfigMapRef` | ConfigMap of **additional** public keys, one `<keyId>.pub` entry each | Optional, off by default. The trust anchor is the release keyring embedded in the operator binary (§2a). An extra keyring is an explicit opt-in, reported as a `Warning` event and the `ExtraKeyringInUse` reason on `BundleVerified` every reconcile. It can add key ids but never replace an embedded one. |
| `spec.dataKeySecretRef` | `{name, key}` of the Secret holding `REGULAIT_DATA_KEY` | Required. The value is never in the CR. |
| `spec.databaseUrlSecretRef` | `{name, key}` of the Secret holding the database URL | Required. |
| `spec.bootstrapTokenSecretRef` | `{name, key}` of the Secret holding `REGULAIT_BOOTSTRAP_TOKEN` | Required. |
| `spec.installSecretsClaimName` | PVC mounted at `/app/install-secrets` | Optional. When empty, the operator creates a 1 GiB `ReadWriteOnce` claim **without** an owner reference, so deleting the CR never deletes the keys. The claim holds the install-generated signing keys unencrypted: their protection at rest is the StorageClass's. Use an encrypted StorageClass, named by `spec.installSecretsStorageClassName`. |
| `spec.backup` | `schedule` (cron), `retentionDays`, `destinationClaimName`, `image` (by digest), `disabled` | `schedule` defaults to `17 2 * * *`, `retentionDays` to 14. Without a destination the installation is not `Ready` (condition `BackupConfigured=False`). Turning backup off takes `disabled: true`, which the operator records as a `Warning` event and a condition every reconcile. The dump follows ADR-0035: values encrypted with the data key stay ciphertext, everything else is plain, so the destination claim must use an encrypted StorageClass and the data key is never written next to it. |
| `spec.egress` | `allowedCIDRs`, `databaseCIDRs`, `allowPublicEgress`, `dns` | Default-deny for ingress and egress, per workload (§2b). For the gateway, egress opens only DNS (`spec.egress.dns`, defaulting to the `k8s-app: kube-dns` pods in `kube-system` on 53/UDP and 53/TCP; a cluster using NodeLocal DNSCache or a renamed CoreDNS names its own selector or link-local CIDR there), the database CIDRs on 5432, and `allowedCIDRs`. `allowPublicEgress` (default `false`) is what a `byoc` install sets to reach model vendors: `0.0.0.0/0` and `::/0` on 443 only, with `except` for `169.254.0.0/16` (instance metadata), the RFC 1918 ranges, `100.64.0.0/10` and the IPv6 private and link-local ranges. NetworkPolicy so backs up the gateway's own egress guard. A private destination is reached only through `allowedCIDRs`. Public egress is refused in `air_gapped`, as is any `allowedCIDRs` entry that is not a private range. |
| `spec.ingressFrom` | Namespace and pod selectors allowed to reach port 3000 | Default: nothing. The installation answers no one until the operator's user names the ingress controller. |
| `spec.replicas` | Gateway replicas | Default 1, maximum 1 in v1alpha1 (see 4). |

`status` carries `observedGeneration`, `installedVersion`, `verifiedManifestSHA256`, `driftCorrections` and the
conditions `BundleVerified`, `Migrated`, `BackupConfigured`, `EgressRestricted`, `Available` and `Ready`.

### 2. The reconcile loop rolls out only a verified version

Each reconcile, in order, failing closed at each step (condition `False` with a reason, a `Warning` event, no change to
running workloads):

1. **Validate the spec** beyond what the CRD schema can express (registry host in `allowedRegistries`, private CIDRs in
   `air_gapped`). The CRD schema carries the enum, pattern and required rules, so the API server refuses most bad
   specs before the operator sees them.
2. **Verify the bundle manifest** with the same rules as `scripts/verify-update-bundle.sh`: schema
   `regulait.update-bundle/1`, product `regulait`, a key id matching `^[A-Za-z0-9._-]+$`, a key present in the
   embedded release keyring (§2a), or in the opted-in extra keyring, an Ed25519 signature over the exact manifest bytes (RSA or ECDSA over SHA-256 accepted, as in the
   script), `version == spec.version`, and no downgrade below `status.installedVersion` or below the manifest's
   `minInstalledVersion`. The operator verifies the manifest only; the payload files stay the installer's concern.
3. **Converge the owned objects**: ServiceAccount (no token automount), Service, the NetworkPolicies of §2b, the install-secrets
   claim, the backup CronJob and the gateway Deployment. Any field the operator owns that differs from the desired
   state is put back and counted in `status.driftCorrections`, with a `DriftCorrected` event (pillar 3's drift
   reporting).
4. **Migrate before rolling out**: when `spec.version` differs from `status.installedVersion`, the operator runs a Job
   `<name>-migrate-<version>` from the new image (`node apps/gateway/dist/migrate-job.js`) and changes the
   Deployment's image only after that Job succeeds. A failed Job leaves the old version running (`Migrated=False`).
5. Record `installedVersion` once the new Deployment is available.

### 2a. The trust anchor is compiled into the operator

The release public keys (`infra/release-keys/*.pub`, the set `scripts/verify-update-bundle.sh` pins) are embedded in
the operator binary with `go:embed`. A CI check fails when the embedded copy differs from `infra/release-keys/`. A key
held in a ConfigMap would let anyone who can edit that ConfigMap install their own key and sign any manifest. The check
would then stop accidents but not someone with write access to the namespace. A key rotation ships a new operator
build, the same channel as the shell verifier's keyring.

A customer that signs its own bundles can name an extra keyring (`extraKeyringConfigMapRef`). That is an explicit
opt-in, reported on every reconcile. It adds key ids and never replaces an embedded key: a ConfigMap entry whose id
matches an embedded key with different content is refused.

### 2b. One NetworkPolicy per workload, and a namespace-wide baseline

Every pod the installation runs holds the database URL, so none of them runs without a policy, and each one gets only
what it needs:

| Policy | Selects | Ingress | Egress |
|---|---|---|---|
| `<name>-baseline` | every pod in the namespace (`podSelector: {}`) | none | none |
| `<name>-gateway` | `component: gateway` | port 3000 from `spec.ingressFrom` only | DNS, `databaseCIDRs` on 5432, `allowedCIDRs`, and public 443 when `allowPublicEgress` (byoc only) |
| `<name>-database-clients` | `component: migrate` and `component: backup` (the migration Job, the Helm hook Job and the backup CronJob) | none | DNS and `databaseCIDRs` on 5432 only. Never `allowedCIDRs` or public egress. |

NetworkPolicies add up, so the baseline denies everything any other policy does not open, including for pods that
other tools create in the namespace. The operator's own Deployment has its own allow policy (DNS and the API server).
In the Helm chart all three policies are `pre-install,pre-upgrade` hooks at weight -10, and the migration Job is at
weight 0. Helm creates them, and waits for them to exist, before the Job's pod starts.

### 3. Secure defaults on every pod the operator or chart creates

`runAsNonRoot`, the image's own uid (1000), `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, every
capability dropped, `seccompProfile: RuntimeDefault`, `automountServiceAccountToken: false`, an `emptyDir` for `/tmp`,
resource requests and limits, and `imagePullPolicy: IfNotPresent` on a digest. The operator's own Deployment follows the
same rules. Its metrics endpoint is off by default; its health probes listen on a port no Service exposes.

This covers the Helm migration hook Job too. It carries the same pod and container security context and reads the
database URL only through `secretKeyRef`.

**RBAC scope: one namespace, a namespaced Role.** The operator watches and acts only in its own installation namespace
(`WATCH_NAMESPACE`, required at start; the manager's cache is restricted to it). All of its rights sit in a namespaced
`Role` and `RoleBinding`. Only the CRD itself is cluster-scoped, and it is installed by the administrator, not by the
operator. Watching the whole cluster is not offered in v1alpha1. If it is added later, it is an explicit opt-in with
its own ADR.

**The operator holds no direct Secret permissions.** Its RBAC grants nothing on `secrets`, and the gateway pod reads
them through `secretKeyRef`. This does not stop Secret access. The operator can create Deployments, Jobs and CronJobs,
and whoever can create a pod in a namespace can mount and read every Secret there. So the operator's workload rights
imply read access to the Secrets of the one namespace it manages, and the namespaced Role is what bounds that. A missing
Secret surfaces as the pod failing to start, which the operator reports through `Available`.

The operator's own image is pinned by digest in its Deployment (`config/manager`) and in the chart's `operator.enabled`
path, which refuses to render without a `sha256:` digest.

### 4. One replica until P2 lands

The gateway migrates at boot and keeps per-process state (rate-limit windows, timers). P2 (HA) is still open, so
v1alpha1 caps `spec.replicas` at 1 and the Deployment uses the `Recreate` strategy. The cap is a schema rule that a
later version relaxes when P2 records the replica story.

### 5. The Helm chart and the migration Job

`deploy/helm/regulait/` installs the same workload without the operator, for a customer who wants plain Helm: the
gateway Deployment, Service, NetworkPolicy, ServiceAccount and the install-secrets claim, with the same security
context. The migration Job is a `pre-install,pre-upgrade` hook running `migrate-job.js` from the same image digest.
Values take only Secret **names** (`existingSecret` style); a value that looks like a secret is not a field. The image
is required by digest, and `mode` is required (no default), so `helm install` without a decision fails. The chart
also carries the operator's CRD and controller as an opt-in (`operator.enabled`, default `false`), so one artifact
covers both paths.

**The plain-Helm path checks the signed bundle too (ADR-0180: no install path drops the gate).** The hook Job has an
init container that runs the operator binary's `verify-bundle` command. It takes the operator image by digest, so it
is the same build and carries the same compiled-in keyring. It reads `manifest.json` and `manifest.json.sig` from the
ConfigMap named by `bundle.configMapName` and checks it with the rules of §2. `version` must equal `.Values.version`.
On an upgrade, the downgrade and `minInstalledVersion` checks run against the version on the running Deployment's
`app.kubernetes.io/version` label, which the chart reads with `lookup`. A failed check fails the init container, so the
migration never runs, the release fails and the old version keeps running. `operator.image` (by digest) and
`bundle.configMapName` are therefore required values even when `operator.enabled` is `false`. The extra-keyring opt-in
of §2a is not offered through Helm.

`migrate-job.js` is a small gateway entrypoint that connects, calls `runMigrations` and exits. It is the only gateway
change in this lane.

### 6. Never against a real cluster

Tests run on envtest (a local kube-apiserver and etcd) and the controller-runtime fake client, and the chart is checked
with `helm lint`, `helm template` and kubeconform. No session in this lane applies anything to a real cluster or
touches a cloud account.

## Owner questions (built with the secure default)

1. **Image provenance in the bundle.** Schema `/1` names files, not image digests, so the operator verifies the
   version but trusts `spec.image.digest` as given. Proposed: schema `regulait.update-bundle/2` adds `images[]` with
   digests and the operator refuses a digest the verified manifest does not list.
2. **API group domain.** `deploy.regulait.ai` follows the domain used elsewhere in the repo; renaming after customers
   install it means a CRD migration.
3. **Backup target.** The CronJob writes `pg_dump` output to a PVC. ADR-0035's S3 target, and a customer's own object
   store, need a credential story that belongs with P2.
4. **Distribution.** Where the operator image and the chart are published (ghcr OCI, a bundle payload, both) is a
   release decision and is not built here.

## Consequences

- Kubernetes customers get a declarative install that refuses an unsigned or downgraded version and puts drifted
  objects back.
- **What the signature gates today.** Schema `/1` names files, not image digests. Until schema `/2` (owner question 1)
  binds `spec.image.digest` into the signed manifest, the signature gates the **version label**, not the code that
  runs. Someone who can edit the RegulaitInstallation can point a verified version at any digest in an allowed
  registry. `allowedRegistries` and the namespace's RBAC are the controls until then.
- The release keyring lives in two places: `infra/release-keys/` and the operator's embedded copy. CI keeps them
  equal, and a key rotation needs a new operator build.
- The repo gains a second Go module (`deploy/operator/`) with its own CI workflow and `THIRD_PARTY.md`, following the
  endpoint agent's pattern (linked modules must be listed).
- Two install paths (Compose and Kubernetes) must stay equivalent. The chart and the operator render the same pod
  spec rules, and a test pins the security context in both.
- **Migrations still run at boot.** The gateway keeps calling `runMigrations` in `startGateway`, so after the migration
  Job succeeds the new pod migrates again. That is a no-op, and with `Recreate` and one replica there is no race. When
  P2 lifts the replica cap, boot-time migration needs a switch (for example `REGULAIT_MIGRATE_ON_BOOT=false`) that the
  operator and the chart set, so replicas never migrate concurrently.
- **Data at rest on claims.** The install-secrets claim (signing keys) and the backup claim (dumps whose non-data-key
  columns are plain) are protected only by their StorageClass. The docs and the sample name an encrypted class.
- Not built here: multi-replica HA (P2), image publication and signing, OLM packaging, and the bundle schema `/2`.
