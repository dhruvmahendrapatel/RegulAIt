# ADR-0305: Distribute the Helm chart as a signed OCI artifact and in the bundle; back up Postgres to S3 in the customer's account

- **Status**: Accepted (owner decisions, 2026-11-15)
- **Date**: 2026-11-15
- **Index**: **Two ADR-0304 open questions closed. The chart is published as a cosign-signed OCI artifact and shipped inside the signed update bundle for air-gapped sites. The operator's backup CronJob can write `pg_dump` output to an S3 bucket in the customer's own AWS account (SSE-KMS with the customer's key, bucket-owner check, credentials from IRSA or EKS Pod Identity, no key in the spec), with versioning and lifecycle set on the bucket.**
- **Backlog item**: [PENDING.md](../product/PENDING.md) P22 (the ADR-0304 "backup target" and "distribution" questions)
- **Built in**: lane L12, in the Helm chart PR (#817)
- **Migration**: none
- **Related**: [ADR-0304](0304-kubernetes-operator-and-helm-chart.md) (operator and chart), [ADR-0041](0041-byoc-primary-motion.md)
  (signed update bundles), ADR-0035 (`pg_dump` backups and the data key), ADR-0325 (BYOC AWS pilot, lane E10: the
  Terraform module that creates the bucket, key and role), ADR-0176, ADR-0180

## Context

ADR-0304 left the backup target (a PVC only) and the chart's distribution open. A BYOC pilot in a customer's AWS account
needs both: the customer's team installs from a runbook, and all pilot data, backups included, stays in that account.

## Decision

### 1. Chart distribution

- `.github/workflows/helm-chart.yml` packages the chart on every run and round-trips it through a local OCI registry
  (`helm push`, `helm pull`, byte-compare), so a packaging break fails the PR.
- A `workflow_dispatch` run with `publish: true` on `main` pushes `oci://ghcr.io/<owner>/charts/regulait`, signs the
  pushed digest with `cosign sign` (keyless: Sigstore with the workflow's GitHub OIDC identity) and verifies it with
  the pinned issuer and workflow identity before the job succeeds. Publishing is manual and `main`-only.
- **Interim signing.** Keyless CI signing stands in until the release-key ceremony (lane E9) lands. The ceremony's key
  then signs the same digests; the verify command in the chart README changes to that key, and the keyless signature
  stays as a second attestation.
- The update bundle's default include list gains `deploy/helm` and `deploy/operator/config`, so an air-gapped site gets
  the chart and the operator's CRD, Role and manager manifests under the bundle's release-key signature and needs no
  registry.

### 2. Backups to S3 in the customer's account

`spec.backup.s3` (`bucket`, `region`, `prefix`, `kmsKeyARN`, `expectedBucketOwner`, `uploaderImage`, `roleARN`,
`podIdentity`, `egressCIDRs`) is an alternative to `destinationClaimName`; the CRD refuses both together.

- **Two containers.** `pg_dump` runs as an init container into a pod-local `emptyDir`. The uploader, which has no
  database URL, runs `aws s3 cp --sse aws:kms --sse-kms-key-id <key> --expected-bucket-owner <account>`. Both images
  are pinned by digest and must come from `image.allowedRegistries` when it is set.
- **No static credentials.** The pod runs as its own ServiceAccount, `<name>-backup` (no API token). Credentials come
  from IRSA (`roleARN` becomes the `eks.amazonaws.com/role-arn` annotation) or an EKS Pod Identity association. The
  gateway never holds the backup role.
- **Least privilege.** The role needs only `s3:PutObject` on the prefix and `kms:GenerateDataKey` on the key: no read,
  list or delete, so a compromised backup pod cannot read or destroy earlier backups.
- **Retention is the bucket's.** Versioning, lifecycle expiry and (optionally) Object Lock are set on the bucket by the
  E10 Terraform module; `retentionDays` applies to the claim path only.
- **Egress.** A new always-applied NetworkPolicy, `<name>-backup-object-store`, opens 443 to `egressCIDRs` (the S3 and
  STS VPC endpoints) for backup pods only. The CIDRs pass the same checks as every egress list (no link-local or
  metadata address; private only in `air_gapped`). `podIdentity: true` opens TCP 80 to the Pod Identity agent
  (169.254.170.23 and fd00:ec2::23) for backup pods only: a deliberate, narrow exception to the link-local refusal,
  reported by the `PublicEgress` condition and a Warning event on every reconcile (ADR-0180).
- `BackupConfigured` names the bucket, prefix, region, owner account and key on every reconcile.

### Interface for lane E10

E10 keeps to these names: the ServiceAccount `<installation>-backup` in the installation namespace; the IAM actions
above; the bucket's versioning and lifecycle; the VPC endpoint CIDRs as `egressCIDRs`.

## Consequences

- A backup is useless without the data key (ADR-0035). The runbook keeps the data key outside the cluster and outside
  the backup bucket.
- The chart itself does not schedule backups; they are an operator feature.
- Restore is manual (`aws s3 cp` then `pg_restore`), documented in the runbook; an automated restore check is open.

## Open (owner)

- Object Lock (compliance mode) on the pilot bucket, which makes backups undeletable for the retention period.
- An automated restore rehearsal.
