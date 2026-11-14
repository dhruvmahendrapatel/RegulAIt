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
| `spec.installSecretsClaimName` | PVC mounted at `/app/install-secrets` | Optional. When empty, the operator creates a 1 GiB `ReadWriteOnce` claim **without** an owner reference, so deleting the CR never deletes the keys. |
| `spec.backup` | `schedule` (cron), `retentionDays`, `destinationClaimName`, `image` (by digest), `disabled` | `schedule` defaults to `17 2 * * *`, `retentionDays` to 14. Without a destination the installation is not `Ready` (condition `BackupConfigured=False`). Turning backup off takes `disabled: true`, which the operator records as a `Warning` event and a condition every reconcile. |
| `spec.egress` | `allowedCIDRs`, `databaseCIDRs`, `allowPublicEgress` | NetworkPolicy is always default-deny for ingress and egress. Egress opens only DNS to the cluster DNS pods (`k8s-app: kube-dns` in `kube-system`) on 53/UDP and 53/TCP, the database CIDRs on 5432, and `allowedCIDRs`. `allowPublicEgress` (default `false`) is what a `byoc` install sets to reach model vendors: `0.0.0.0/0` and `::/0` on 443 only, with `except` for `169.254.0.0/16` (instance metadata), the RFC 1918 ranges, `100.64.0.0/10` and the IPv6 private and link-local ranges. NetworkPolicy so backs up the gateway's own egress guard. A private destination is reached only through `allowedCIDRs`. Public egress is refused in `air_gapped`, as is any `allowedCIDRs` entry that is not a private range. |
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
3. **Converge the owned objects**: ServiceAccount (no token automount), Service, NetworkPolicy, the install-secrets
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
- Not built here: multi-replica HA (P2), image publication and signing, OLM packaging, and the bundle schema `/2`.

## As built (operator, lane L12 PR 2)

- `deploy/operator/` uses controller-runtime v0.25.2 and k8s.io/* v0.37.0, with Go 1.26. Envtest runs kube-apiserver
  and etcd 1.37.0. `govulncheck` is clean after `golang.org/x/net`, `grpc`, `otel` and `cel-go` were raised to their
  fixed versions.
- Two details beyond §1: `spec.egress.allowPublicEgress` opens public addresses on **443 only** (private ranges
  excluded), and `status.installedImage` (repository@digest) sits next to `installedVersion`. A new digest therefore
  always migrates, even at the same version. A `SpecValid` condition carries the operator-side validation result.
- Drift is detected by server-side apply under the field manager `regulait-operator`. A write that changes an owned
  object while the spec and the installed image are unchanged counts as drift.
- Events go through the `events.k8s.io/v1` recorder, and the Role grants `events.k8s.io` rather than core events.
- Bundle parsing refuses a manifest that repeats a top-level key. The shell verifier reads the first occurrence and
  `encoding/json` the last, so a duplicated `version` could otherwise mean two things.
- Versions are compared with `golang.org/x/mod/semver`. Unlike the shell verifier, it orders a pre-release below its
  release, so `1.0.0-rc.1` after `1.0.0` is a downgrade. That is stricter, and it is deliberate.
- The gateway gains `migrate-job.ts`, a thin entrypoint over a testable `migrate-job-run.ts`. It refuses to run without
  `DATABASE_URL` instead of falling back to a default database, and it never logs the URL.

## As built (Helm chart, lane L12 PR 3)

- `deploy/helm/regulait/` has a `values.schema.json` with `additionalProperties: false` at every level, so a secret
  value cannot be passed as a value. `mode`, `version`, the image and `secrets.name` have no default.
- The three NetworkPolicies of §2b are ordinary release resources, not hooks as §2b and §5 first said. Hook resources
  are deleted and recreated on every upgrade (`before-hook-creation`), which would leave the running gateway briefly
  un-isolated, and they outlive `helm uninstall`. Only a copy of the database-clients policy,
  `<release>-hook-database-clients`, is a `pre-install,pre-upgrade` hook at weight -10, so the first migration Job
  (weight 0) never runs unpoliced; it is deleted once the hook phase succeeds. This follows the code review on #792.
- The downgrade check reads the installed version from `bundle.installedVersion` when set, else the running
  Deployment's version label through `lookup`. An upgrade with neither (`helm template --is-upgrade`, `--dry-run`,
  GitOps renderers, where `lookup` is empty) fails the render rather than skip the check. The explicit value is the
  stronger source, since the label is writable by anyone with write access to the namespace (security review on #792).
- The migration Job uses the namespace's default ServiceAccount with no token mounted, because the release's own
  ServiceAccount does not exist while pre-install hooks run.
- `operator.enabled` renders the CRD and the Role from `files/crd.yaml` and `files/role.yaml`. These are copies of the
  operator's generated files, and `tests/render-test.sh` fails when they differ.
- In the templates, the air-gapped private-range check is prefix-pattern based (10/8, 172.16/12, 192.168/16,
  100.64/10, fc00::/7, each with a minimum prefix length). The operator does the exact `netip` containment check.
