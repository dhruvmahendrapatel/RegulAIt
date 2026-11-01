# --- host-account foundation, created ONCE under break-glass (ADR-0228) ------------
#
# The recurring deployer (`RegulAItDemoDeployer`, DEMO_RUNBOOK.md §8.4 step 3) is
# assigned only in the demo-host account and has no access to the management
# account. So the two things it must rely on, but must never be able to change,
# are created here by the one-time privileged bootstrap:
#
#   1. its Terraform state backend, in the host account (S3 + DynamoDB lock,
#      KMS, versioned, TLS-only, no public access);
#   2. the permissions boundary every IAM role it creates must carry.
#
# The boundary caps any role the deployer creates, whatever policy is attached
# to it later: no IAM, no Organizations, no role assumption except the anchor
# role, no CloudTrail/Config/GuardDuty/Security Hub writes, no KMS key
# administration, and no writes that weaken or erase evidence (bucket policy,
# versioning, lifecycle, lock, deletes; log-group deletion or retention).
# The deployer's own permission set denies every change to this policy.

locals {
  host_prefix      = "regulait-demo-host"
  host_anchor_role = "arn:aws:iam::${var.host_account_id}:role/${local.host_prefix}-anchor"
}

data "aws_iam_policy_document" "host_role_boundary" {
  # A boundary is a ceiling: effective permissions are the role's own policies
  # intersected with this. Allow everything, then carve out what no deployed
  # role may ever do.
  statement {
    sid       = "Ceiling"
    actions   = ["*"]
    resources = ["*"]
  }

  statement {
    sid    = "NoIdentityOrOrganizationChanges"
    effect = "Deny"
    actions = [
      "iam:*", "organizations:*", "account:*", "sso:*", "sso-directory:*", "identitystore:*",
      "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity", "sts:GetFederationToken",
    ]
    resources = ["*"]
  }

  # The instance role assumes the audit-anchor role (anchor.tf in ../host);
  # nothing else may be assumed by any deployed role.
  statement {
    sid           = "AssumeOnlyTheAnchorRole"
    effect        = "Deny"
    actions       = ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"]
    not_resources = [local.host_anchor_role]
  }

  statement {
    sid    = "NoAuditOrDetectionWrites"
    effect = "Deny"
    actions = [
      "cloudtrail:Create*", "cloudtrail:Delete*", "cloudtrail:Update*", "cloudtrail:Put*",
      "cloudtrail:StopLogging", "cloudtrail:StartLogging", "cloudtrail:AddTags", "cloudtrail:RemoveTags",
      "config:Put*", "config:Delete*", "config:Stop*", "config:Start*",
      "guardduty:Create*", "guardduty:Update*", "guardduty:Delete*", "guardduty:Disassociate*",
      "guardduty:Stop*", "guardduty:Archive*",
      "securityhub:Create*", "securityhub:Update*", "securityhub:Delete*", "securityhub:Batch*",
      "securityhub:Disable*", "securityhub:Disassociate*",
      "access-analyzer:Create*", "access-analyzer:Delete*", "access-analyzer:Update*",
      "access-analyzer:Apply*", "inspector2:Disable*", "inspector2:Create*", "inspector2:Update*",
      "inspector2:Delete*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "NoKeyAdministration"
    effect = "Deny"
    actions = [
      # Not kms:CreateGrant: the DLM and scheduler roles need it for the
      # CMK-encrypted volumes (snapshots, start).
      "kms:CreateKey", "kms:CreateAlias", "kms:CreateCustomKeyStore", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
      "kms:DisableKey", "kms:EnableKey", "kms:DisableKeyRotation", "kms:EnableKeyRotation",
      "kms:Update*", "kms:Delete*", "kms:ReplicateKey", "kms:RevokeGrant", "kms:TagResource",
      "kms:UntagResource",
    ]
    resources = ["*"]
  }

  # Writers may PutObject (backups, anchors with retention) but never weaken
  # or erase what is already stored.
  statement {
    sid    = "NoEvidenceErasureOrWeakening"
    effect = "Deny"
    actions = [
      "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteObjectTagging", "s3:DeleteBucket*",
      "s3:PutBucket*", "s3:PutLifecycleConfiguration", "s3:PutEncryptionConfiguration",
      "s3:PutReplicationConfiguration", "s3:PutObjectLegalHold", "s3:PutObjectAcl",
      "s3:BypassGovernanceRetention", "s3:PutAccountPublicAccessBlock",
      "logs:DeleteLogGroup", "logs:DeleteLogStream", "logs:PutRetentionPolicy",
      "logs:DeleteRetentionPolicy", "logs:DisassociateKmsKey", "logs:AssociateKmsKey",
      "logs:PutResourcePolicy", "logs:DeleteResourcePolicy", "logs:DeleteDataProtectionPolicy",
      # Not ec2:DeleteSnapshot: DLM expires its own snapshots after 7.
      "ec2:DeleteFlowLogs",
      "dlm:DeleteLifecyclePolicy", "dlm:UpdateLifecyclePolicy",
      "ssm:DeleteDocument", "ssm:UpdateDocument", "ssm:UpdateDocumentDefaultVersion",
      "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "host_role_boundary" {
  provider    = aws.workload
  name        = "${local.host_prefix}-boundary"
  description = "Permissions boundary for every role the demo-host deployer creates (ADR-0228)"
  policy      = data.aws_iam_policy_document.host_role_boundary.json
}

# --- the deployer's state backend, in the host account ---------------------------

resource "aws_kms_key" "host_state" {
  provider                = aws.workload
  description             = "Terraform state of the demo-host host stack (ADR-0228)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "host_state" {
  provider      = aws.workload
  name          = "alias/${local.host_prefix}-tfstate"
  target_key_id = aws_kms_key.host_state.key_id
}

resource "aws_s3_bucket" "host_state" {
  provider = aws.workload
  bucket   = "${local.host_prefix}-tfstate-${var.host_account_id}"
}

resource "aws_s3_bucket_versioning" "host_state" {
  provider = aws.workload
  bucket   = aws_s3_bucket.host_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "host_state" {
  provider = aws.workload
  bucket   = aws_s3_bucket.host_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.host_state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "host_state" {
  provider                = aws.workload
  bucket                  = aws_s3_bucket.host_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "host_state" {
  provider = aws.workload
  bucket   = aws_s3_bucket.host_state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.host_state.arn, "${aws_s3_bucket.host_state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.host_state]
}

resource "aws_dynamodb_table" "host_state_lock" {
  provider     = aws.workload
  name         = "${local.host_prefix}-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.host_state.arn
  }

  point_in_time_recovery {
    enabled = true
  }
}
