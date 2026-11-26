# Offline plan-only tests. The AWS provider is real (so the IAM policy
# documents are rendered exactly as AWS would receive them) but has fake
# credentials and skips every API call; the account, partition and region
# lookups are overridden. No AWS call is made.

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "fake"
  secret_key                  = "fake"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "111111111111" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

override_data {
  target = data.aws_region.current
  values = { region = "us-east-1" }
}

variables {
  name        = "regulait-test-operator"
  bucket_name = "regulait-test-backups-111111111111"
  prefix      = "pg"
}

run "host_profile_is_unchanged_by_default" {
  command = plan

  variables {
    writer_role_names = ["box-role"]
  }

  assert {
    condition     = var.writer_profile == "host" && length(aws_iam_role_policy_attachment.writer) == 1
    error_message = "The default profile is the host writer, attached to the named role."
  }
}

run "kubernetes_job_profile_is_the_adr_0305_contract" {
  command = plan

  variables {
    writer_profile         = "kubernetes_job"
    kms_key_arn            = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
    writer_role_arns       = ["arn:aws:iam::111111111111:role/regulait-test-operator-backup"]
    enable_freshness_alarm = false
  }

  assert {
    condition = toset(flatten([for s in jsondecode(data.aws_iam_policy_document.writer_kubernetes_job[0].json).Statement : s.Action])) == toset([
      "s3:PutObject", "kms:GenerateDataKey", "kms:Decrypt",
    ])
    error_message = "The Job may only put objects and use the key: no ListBucket, GetObject, Delete or CloudWatch (ADR-0305)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.writer_kubernetes_job[0].json).Statement :
      s.Resource == "arn:aws:s3:::regulait-test-backups-111111111111/pg/*" if s.Sid == "PutBackupsUnderOnePrefixOnly"
    ])
    error_message = "PutObject is confined to the prefix."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.writer_kubernetes_job[0].json).Statement :
      s.Condition.StringEquals["kms:ViaService"] == "s3.us-east-1.amazonaws.com" &&
      contains(flatten([s.Condition.StringLike["kms:EncryptionContext:aws:s3:arn"]]), "arn:aws:s3:::regulait-test-backups-111111111111")
      if s.Sid == "UseTheKeyOnlyForUploadsToThisBucket"
    ])
    error_message = "Both KMS actions are pinned to S3 in this region and to this bucket's encryption context."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.writer) == 0 && length(aws_cloudwatch_metric_alarm.freshness) == 0
    error_message = "A writer given by ARN attaches the policy itself, and the Job has no heartbeat alarm."
  }

  assert {
    condition     = contains(local.writer_role_arns, "arn:aws:iam::111111111111:role/regulait-test-operator-backup")
    error_message = "A writer given by ARN is among the principals the bucket policy's explicit Deny names."
  }
}

run "kubernetes_job_needs_a_key" {
  command = plan

  variables {
    writer_profile         = "kubernetes_job"
    enable_freshness_alarm = false
  }

  expect_failures = [aws_iam_policy.writer]
}
