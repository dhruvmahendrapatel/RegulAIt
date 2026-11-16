# One customer-managed key for the stack's data at rest: RDS storage and its
# managed master-password secret, the audit-anchor bucket, Kubernetes secrets
# (EKS envelope encryption), EBS volumes, ECR and the CloudWatch log groups.
# Rotated yearly. The key never leaves the customer's account; RegulAIt (the
# vendor) has no grant on it. Built with terraform-aws-modules/kms (ADR-0176).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
}

module "kms" {
  source  = "terraform-aws-modules/kms/aws"
  version = "4.2.2"

  description             = "${var.name_prefix}: data at rest (RDS, audit anchors, Kubernetes secrets, volumes, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  aliases                 = ["${var.name_prefix}-data"]

  # The default statement lets the account administer the key through IAM
  # (account root principal, kms:*); nothing else is granted by default.
  enable_default_policy = true

  key_statements = [{
    sid = "CloudWatchLogsForThisAccountOnly"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]
    principals = [{
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }]
    condition = [{
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account}:log-group:*"]
    }]
  }]

  tags = var.tags
}
