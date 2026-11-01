# --- detection and evidence in the host account (ADR-0228) -------------------------
# The organization-wide controls (CloudTrail in every region with log-file
# validation and KMS, GuardDuty, Security Hub with FSBP and CIS, AWS Config, the
# budget) come from ../baseline. These are the account-level additions.

# IAM Access Analyzer, account zone of trust: reports anything shared outside it.
resource "aws_accessanalyzer_analyzer" "account" {
  analyzer_name = "${local.name}-account"
  type          = "ACCOUNT"
}

# Amazon Inspector: EC2 (packages, network reachability) and ECR scanning.
resource "aws_inspector2_enabler" "this" {
  account_ids    = [local.account_id]
  resource_types = ["EC2", "ECR"]
}

# --- patching: a baseline, a daily scan, an install the owner runs (§8.4) --------
resource "aws_ssm_patch_baseline" "al2023" {
  name             = "${local.name}-al2023"
  description      = "Amazon Linux 2023: security and bugfix updates, approved after 0 days"
  operating_system = "AMAZON_LINUX_2023"

  approval_rule {
    approve_after_days  = 0
    enable_non_security = false
    patch_filter {
      key    = "CLASSIFICATION"
      values = ["Security", "Bugfix"]
    }
    patch_filter {
      key    = "SEVERITY"
      values = ["Critical", "Important", "Medium", "Low"]
    }
  }
}

resource "aws_ssm_default_patch_baseline" "al2023" {
  baseline_id      = aws_ssm_patch_baseline.al2023.id
  operating_system = "AMAZON_LINUX_2023"
}

# Scan only, daily: a compliance report with no reboot, so nothing restarts the
# host during the demo. Installing is a deliberate owner step (§8.4).
resource "aws_ssm_association" "patch_scan" {
  name                = "AWS-RunPatchBaseline"
  association_name    = "${local.name}-patch-scan"
  schedule_expression = "rate(1 day)"
  parameters = {
    Operation = "Scan"
  }
  targets {
    key    = "InstanceIds"
    values = [module.app.instance_id]
  }
}

# --- encrypted EBS snapshots (DLM) -----------------------------------------------
# Daily snapshots of every volume tagged Snapshot=<name>, kept 7 days. Snapshots of
# a CMK-encrypted volume stay encrypted with the same key.
resource "aws_iam_role" "dlm" {
  name                 = "${local.name}-dlm"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_iam_role_policy" "dlm_kms" {
  name = "snapshot-cmk"
  role = aws_iam_role.dlm.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
      Resource = aws_kms_key.host.arn
    }]
  })
}

resource "aws_dlm_lifecycle_policy" "snapshots" {
  description        = "${local.name} daily encrypted snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Snapshot = local.name }

    schedule {
      name      = "daily-7"
      copy_tags = true
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["06:00"]
      }
      retain_rule {
        count = 7
      }
    }
  }
}
