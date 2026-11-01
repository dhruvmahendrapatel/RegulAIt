# --- audit-chain anchor: S3 Object Lock in COMPLIANCE mode (ADR-0228 addendum 2) ---
#
# The gateway grades its anchor store by asking the bucket
# (GetObjectLockConfiguration, apps/gateway/src/audit-chain.ts): only COMPLIANCE
# earns "tamper-resistant" on /v1/audit/verify (beat G8). This bucket is that
# store: versioned, Block Public Access, SSE-KMS with the host key, TLS-only,
# COMPLIANCE default retention of var.anchor_retention_days.
#
# The anchor role's grant is the module's writer grant (ADR-0060 amendment
# 2026-11-01): the sink's exact calls — locked PUT (PutObject +
# PutObjectRetention), read-back by version, GetObjectRetention,
# ListObjectVersions, GetBucketObjectLockConfiguration — and the host KMS key
# through S3 only. The module's bucket policy denies the role every delete,
# governance bypass, legal hold and bucket-weakening call, and any PUT whose
# lock is weaker or shorter than the bucket's. The gateway's
# REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS comes from the same
# anchor_retention_days (demo-host-env.sh), so it meets the retention floor.
#
# CREDENTIALS WITHOUT RELAXING IMDS. The gateway runs in a container, and the
# instance's IMDS hop limit of 1 keeps containers away from the instance role on
# purpose. So the gateway gets its own role, `anchor`, which can do nothing but
# the calls below; a host timer (infra/scripts/demo-host-anchor-creds.sh)
# assumes it every 15 minutes and hands the 1-hour credentials to the gateway
# through a tmpfs file read by the SDK's credential_process. No long-lived key.
#
# COMPLIANCE CANNOT BE UNDONE: no principal, root included, can delete an anchor
# version before its retention ends, so this bucket outlives `terraform destroy`
# by up to anchor_retention_days (DEMO_RUNBOOK.md §8.11).

module "anchor" {
  source = "../../../modules/audit-anchor-worm-s3"

  name             = "${local.name}-anchor"
  bucket_name      = "${local.name}-audit-anchor-${local.account_id}"
  prefix           = local.anchor_prefix
  object_lock_mode = "COMPLIANCE"
  retention_days   = var.anchor_retention_days
  kms_key_arn      = aws_kms_key.host.arn

  # Same account, so the module's role-name-to-ARN mapping holds. The reference
  # also orders the role before the bucket policy that names it as a principal.
  writer_role_names = [aws_iam_role.anchor.name]
}

locals {
  anchor_prefix = "audit-anchors"
}

resource "aws_iam_role" "anchor" {
  name = "${local.name}-anchor"
  # Every role this stack creates carries the boundary (ADR-0228).
  permissions_boundary = local.boundary_arn
  description          = "Audit-chain anchor writer for the demo gateway; assumed by the instance role only"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = module.app.instance_role_arn }
      Action    = "sts:AssumeRole"
    }]
  })
  max_session_duration = 3600
}

# Non-secret wiring the host reads (demo-host-env.sh, demo-host-anchor-creds.sh).
resource "aws_ssm_parameter" "anchor_bucket" {
  name  = "${local.ssm_prefix}/anchor-bucket"
  type  = "String"
  value = module.anchor.bucket
}

resource "aws_ssm_parameter" "anchor_role_arn" {
  name  = "${local.ssm_prefix}/anchor-role-arn"
  type  = "String"
  value = aws_iam_role.anchor.arn
}

resource "aws_ssm_parameter" "anchor_retention_days" {
  name  = "${local.ssm_prefix}/anchor-retention-days"
  type  = "String"
  value = tostring(var.anchor_retention_days)
}
