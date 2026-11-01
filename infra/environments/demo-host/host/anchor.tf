# --- audit-chain anchor: S3 Object Lock in COMPLIANCE mode (ADR-0228 addendum 2) ---
#
# The gateway grades its anchor store by asking the bucket
# (GetObjectLockConfiguration, apps/gateway/src/audit-chain.ts): only COMPLIANCE
# earns "tamper-resistant" on /v1/audit/verify (beat G8). This bucket is that
# store: versioned, Block Public Access, SSE-KMS with the host key, TLS-only,
# COMPLIANCE default retention of var.anchor_retention_days.
#
# Reuses modules/audit-anchor-worm-s3 with NO writer_role_names: the module's
# writer grant is PutObject only and its bucket policy denies the writer
# s3:PutObjectRetention, but the gateway's sink PUTs with ObjectLockMode and
# RetainUntilDate (which needs PutObjectRetention) and reads its anchor back by
# version. So the grant lives here, sized to the exact calls the sink makes.
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

  writer_role_names = []
}

locals {
  anchor_prefix = "audit-anchors"
}

resource "aws_iam_role" "anchor" {
  name        = "${local.name}-anchor"
  description = "Audit-chain anchor writer for the demo gateway; assumed by the instance role only"
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

data "aws_iam_policy_document" "anchor" {
  # The object calls the sink makes: PutObject with ObjectLockMode and
  # RetainUntilDate (needs PutObjectRetention; in COMPLIANCE mode a retention
  # can only be extended, never shortened), GetObject by VersionId,
  # GetObjectRetention.
  statement {
    sid = "AnchorObjects"
    actions = [
      "s3:PutObject",
      "s3:PutObjectRetention",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectRetention",
    ]
    resources = ["${module.anchor.bucket_arn}/${local.anchor_prefix}/*"]
  }

  # HeadBucket (s3:ListBucket) and ListObjectVersions, under the prefix only.
  statement {
    sid       = "ListAnchorPrefix"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [module.anchor.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.anchor_prefix}/*", ""]
    }
  }

  # The grade: the bucket's own Object Lock answer.
  statement {
    sid       = "ReadLockConfiguration"
    actions   = ["s3:GetBucketObjectLockConfiguration"]
    resources = [module.anchor.bucket_arn]
  }

  statement {
    sid       = "UseHostKeyThroughS3Only"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.host.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  # Never destroy or weaken, whatever else is granted later.
  statement {
    sid    = "NeverDestroyOrWeaken"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:PutObjectLegalHold",
      "s3:BypassGovernanceRetention",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketPolicy",
      "s3:DeleteBucket",
    ]
    resources = [module.anchor.bucket_arn, "${module.anchor.bucket_arn}/*"]
  }
}

resource "aws_iam_role_policy" "anchor" {
  name   = "audit-anchor-writer"
  role   = aws_iam_role.anchor.id
  policy = data.aws_iam_policy_document.anchor.json
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
