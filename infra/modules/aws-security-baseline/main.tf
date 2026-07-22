### CloudTrail — org-wide trail, log-file validation, KMS-encrypted, in Management ###

resource "aws_kms_key" "cloudtrail" {
  provider                = aws.management
  description             = "${var.project} CloudTrail log encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RootAccountFullAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.management_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudTrailEncrypt"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = ["kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          StringLike = {
            "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${var.management_account_id}:trail/*"
          }
        }
      },
      {
        Sid       = "AllowCloudTrailDecryptForLogReaders"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.management_account_id}:root" }
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = {
          StringLike = {
            "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${var.management_account_id}:trail/*"
          }
        }
      }
    ]
  })
}

resource "aws_kms_alias" "cloudtrail" {
  provider      = aws.management
  name          = "alias/${var.project}-cloudtrail"
  target_key_id = aws_kms_key.cloudtrail.key_id
}

resource "aws_s3_bucket" "cloudtrail" {
  provider = aws.management
  bucket   = "${var.project}-cloudtrail-logs-${var.management_account_id}"
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  provider = aws.management
  bucket   = aws_s3_bucket.cloudtrail.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  provider = aws.management
  bucket   = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.cloudtrail.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  provider                = aws.management
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

# Deny-delete: removing this policy is itself a deliberate, auditable, separate
# action from deleting log objects — combined with versioning, this is the
# "even an account admin can't quietly purge history" property called out in
# ADR-0002, without the added complexity of Object Lock for a day-one setup.
resource "aws_s3_bucket_policy" "cloudtrail" {
  provider = aws.management
  bucket   = aws_s3_bucket.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.cloudtrail.arn
        Condition = { StringEquals = { "aws:SourceOrgID" = var.organization_id } }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cloudtrail.arn}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"    = "bucket-owner-full-control"
            "aws:SourceOrgID" = var.organization_id
          }
        }
      },
      {
        Sid       = "DenyDeleteBucket"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:DeleteBucket"
        Resource  = aws_s3_bucket.cloudtrail.arn
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.cloudtrail.arn, "${aws_s3_bucket.cloudtrail.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
}

resource "aws_cloudtrail" "org" {
  provider                      = aws.management
  name                          = "${var.project}-org-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.cloudtrail.arn

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

### GuardDuty — org-wide, auto-enable member accounts ###
# Both aws_guardduty_organization_configuration and
# aws_securityhub_organization_configuration below require the calling
# account to first be registered as that service's Organizations delegated
# admin — without this they fail (or, worse, hang retrying against AWS's
# eventual-consistency backoff) since the precondition can never become true
# on its own. Management self-registers as admin for both, keeping this a
# 2-account setup rather than adding a dedicated security-tooling account.

resource "aws_guardduty_organization_admin_account" "this" {
  provider         = aws.management
  admin_account_id = var.management_account_id
}

resource "aws_guardduty_detector" "management" {
  provider = aws.management
  enable   = true
}

resource "aws_guardduty_organization_configuration" "org" {
  provider    = aws.management
  detector_id = aws_guardduty_detector.management.id

  auto_enable_organization_members = "ALL"

  depends_on = [aws_guardduty_organization_admin_account.this]
}

### Security Hub — org-wide, Foundational Security Best Practices standard ###

resource "aws_securityhub_organization_admin_account" "this" {
  provider         = aws.management
  admin_account_id = var.management_account_id
}

resource "aws_securityhub_account" "management" {
  provider                 = aws.management
  enable_default_standards = true # already includes AWS Foundational Security Best Practices
}

resource "aws_securityhub_organization_configuration" "org" {
  provider    = aws.management
  auto_enable = true

  depends_on = [aws_securityhub_account.management, aws_securityhub_organization_admin_account.this]
}

### AWS Config — recorder + delivery channel in both accounts, aggregator in Management ###

resource "aws_s3_bucket" "config" {
  provider = aws.management
  bucket   = "${var.project}-config-recordings-${var.management_account_id}"
}

resource "aws_s3_bucket_public_access_block" "config" {
  provider                = aws.management
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "config" {
  provider = aws.management
  bucket   = aws_s3_bucket.config.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSConfigBucketPermissionsCheck"
        Effect    = "Allow"
        Principal = { Service = "config.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.config.arn
        Condition = { StringEquals = { "aws:SourceOrgID" = var.organization_id } }
      },
      {
        Sid       = "AWSConfigBucketWrite"
        Effect    = "Allow"
        Principal = { Service = "config.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.config.arn}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"    = "bucket-owner-full-control"
            "aws:SourceOrgID" = var.organization_id
          }
        }
      }
    ]
  })
}

resource "aws_iam_role" "config_management" {
  provider = aws.management
  name     = "${var.project}-config-recorder"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "config.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "config_management" {
  provider   = aws.management
  role       = aws_iam_role.config_management.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_config_configuration_recorder" "management" {
  provider = aws.management
  name     = "${var.project}-recorder"
  role_arn = aws_iam_role.config_management.arn
  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "management" {
  provider       = aws.management
  name           = "${var.project}-delivery"
  s3_bucket_name = aws_s3_bucket.config.id
  depends_on     = [aws_config_configuration_recorder.management]
}

resource "aws_config_configuration_recorder_status" "management" {
  provider   = aws.management
  name       = aws_config_configuration_recorder.management.name
  is_enabled = true
  depends_on = [aws_config_delivery_channel.management]
}

resource "aws_iam_role" "config_workload" {
  provider = aws.workload
  name     = "${var.project}-config-recorder"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "config.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "config_workload" {
  provider   = aws.workload
  role       = aws_iam_role.config_workload.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_config_configuration_recorder" "workload" {
  provider = aws.workload
  name     = "${var.project}-recorder"
  role_arn = aws_iam_role.config_workload.arn
  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "workload" {
  provider       = aws.workload
  name           = "${var.project}-delivery"
  s3_bucket_name = aws_s3_bucket.config.id
  s3_key_prefix  = "workload-account"
  depends_on     = [aws_config_configuration_recorder.workload]
}

resource "aws_config_configuration_recorder_status" "workload" {
  provider   = aws.workload
  name       = aws_config_configuration_recorder.workload.name
  is_enabled = true
  depends_on = [aws_config_delivery_channel.workload]
}

# Account-based aggregation requires the source account to explicitly
# authorize the aggregator account first — without this, the aggregator
# is created but silently never receives the workload account's data.
resource "aws_config_aggregate_authorization" "workload_to_management" {
  provider              = aws.workload
  account_id            = var.management_account_id
  authorized_aws_region = var.aws_region
}

resource "aws_config_configuration_aggregator" "org" {
  provider = aws.management
  name     = "${var.project}-aggregator"

  account_aggregation_source {
    account_ids = [var.management_account_id, var.workload_account_id]
    all_regions = true
  }

  depends_on = [aws_config_aggregate_authorization.workload_to_management]
}

### S3 account-level Block Public Access — both accounts ###

resource "aws_s3_account_public_access_block" "management" {
  provider                = aws.management
  account_id              = var.management_account_id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_account_public_access_block" "workload" {
  provider                = aws.workload
  account_id              = var.workload_account_id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

### Budgets — staged thresholds, org-wide (created in Management, covers consolidated billing) ###

resource "aws_budgets_budget" "monthly" {
  provider     = aws.management
  name         = "${var.project}-monthly-budget"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = var.budget_notification_emails
    }
  }
}

### Baseline SCPs — attached at the Organization root ###
# Note: SCPs never apply to the Management account itself (AWS built-in
# exemption) — these only constrain member (workload) accounts.

resource "aws_organizations_policy" "deny_leave_org" {
  provider = aws.management
  name     = "${var.project}-deny-leave-org"
  type     = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DenyLeaveOrganization"
      Effect   = "Deny"
      Action   = "organizations:LeaveOrganization"
      Resource = "*"
    }]
  })
}

resource "aws_organizations_policy_attachment" "deny_leave_org" {
  provider  = aws.management
  policy_id = aws_organizations_policy.deny_leave_org.id
  target_id = var.organization_root_id
}

resource "aws_organizations_policy" "deny_disable_guardrails" {
  provider = aws.management
  name     = "${var.project}-deny-disable-guardrails"
  type     = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "DenyDisableSecurityServices"
      Effect = "Deny"
      Action = [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "guardduty:DeleteDetector",
        "guardduty:DisassociateFromMasterAccount",
        "guardduty:UpdateDetector",
        "securityhub:DisableSecurityHub",
        "securityhub:DisassociateFromMasterAccount",
        "config:DeleteConfigurationRecorder",
        "config:StopConfigurationRecorder",
        "config:DeleteDeliveryChannel",
        "s3:PutAccountPublicAccessBlock"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_organizations_policy_attachment" "deny_disable_guardrails" {
  provider  = aws.management
  policy_id = aws_organizations_policy.deny_disable_guardrails.id
  target_id = var.organization_root_id
}

resource "aws_organizations_policy" "region_allowlist" {
  provider = aws.management
  name     = "${var.project}-region-allowlist"
  type     = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "DenyOutsideAllowedRegions"
      Effect = "Deny"
      NotAction = [
        "iam:*", "organizations:*", "sts:*", "support:*", "budgets:*",
        "route53:*", "cloudfront:*", "waf:*", "wafv2:*",
        "guardduty:*", "securityhub:*", "config:*", "cloudtrail:*"
      ]
      Resource = "*"
      Condition = {
        StringNotEquals = { "aws:RequestedRegion" = var.allowed_regions }
      }
    }]
  })
}

resource "aws_organizations_policy_attachment" "region_allowlist" {
  provider  = aws.management
  policy_id = aws_organizations_policy.region_allowlist.id
  target_id = var.organization_root_id
}

### Permissions boundary — attached to any role Deploy-Builder (or CI) creates ###

resource "aws_iam_policy" "deploy_builder_boundary" {
  provider    = aws.workload
  name        = "${var.project}-deploy-builder-boundary"
  description = "Permissions boundary applied to any IAM role created by Deploy-Builder or CI — structural self-escalation prevention."
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEverythingElse"
        Effect = "Allow"
        NotAction = [
          "organizations:*",
          "sso:*",
          "sso-admin:*",
          "account:*"
        ]
        Resource = "*"
      },
      {
        Sid    = "DenySelfEscalation"
        Effect = "Deny"
        Action = [
          "iam:CreateUser",
          "iam:CreatePolicyVersion",
          "iam:DeleteUserPermissionsBoundary",
          "iam:DeleteRolePermissionsBoundary"
        ]
        Resource = "*"
      }
    ]
  })
}
