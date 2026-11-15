<!-- fold: state-decisions -->
**ADR-0305 (builder lane L12, 2026-11-15, Accepted; owner decisions): chart distribution and S3 backups.**
- **Chart:** published as a cosign-signed OCI artifact (`oci://ghcr.io/<owner>/charts/regulait`, manual `main`-only
  publish; keyless CI signing until lane E9's release-key ceremony), and shipped in the signed update bundle
  (`deploy/helm`, `deploy/operator/config`) for air-gapped sites.
- **Backups:** `spec.backup.s3` uploads `pg_dump` output to a bucket in the customer's AWS account with SSE-KMS under
  their key and a bucket-owner check; credentials from IRSA or EKS Pod Identity on a dedicated `<name>-backup`
  ServiceAccount; the role needs only `s3:PutObject` and `kms:GenerateDataKey`; retention is the bucket's lifecycle
  (lane E10's Terraform).
- **Open (owner):** Object Lock on the pilot bucket; an automated restore rehearsal.
