# demo-host / host: the demo stack on ONE hardened EC2 instance (ADR-0228).
# A demo environment, never production (CLAUDE.md standing guardrail).
#
#   - no SSH key and NO inbound security-group rule: operators use SSM Session
#     Manager; the public front door is the outbound-only Cloudflare Tunnel,
#     which terminates TLS at Cloudflare (ADR-0203), under the same hostname the
#     laptop used;
#   - IMDSv2 required, hop limit 1 (containers cannot reach the role's credentials);
#   - root and data volumes encrypted with this stack's KMS key; the data volume
#     (every Docker volume, Postgres included) is its own resource and survives
#     an instance replacement;
#   - a least-privilege instance role: SSM core, read its own source bundle,
#     read /regulait/demo-host/* parameters through SSM only, write container
#     logs to one log group, write (never read or delete) its own backup prefix;
#   - nightly verified pg_dump to a versioned, KMS-encrypted bucket
#     (infra/scripts/pg-backup.sh, ADR-0035), with a freshness alarm;
#   - the power schedule exists but is OFF by default, so the host cannot
#     sleep through the demo.
#
# Secrets are never in this stack: the tunnel token and the stack's secrets are
# SecureString parameters the owner creates by hand (DEMO_RUNBOOK.md §8.5), so
# they are not in Terraform state, user-data or the repository.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition
  name       = "regulait-demo-host"
  ssm_prefix = "/regulait/demo-host"

  # Outbound only what the host needs: HTTPS (AWS endpoints, package and image
  # registries, the model provider and the demo integrations) and cloudflared's
  # 7844 over QUIC (udp) or HTTP/2 (tcp). DNS and time use the VPC's link-local
  # resolver and time service, which security groups do not filter.
  egress_rules = [
    { description = "https", from_port = 443, to_port = 443, protocol = "tcp", cidr_blocks = ["0.0.0.0/0"] },
    { description = "cloudflared-tcp", from_port = 7844, to_port = 7844, protocol = "tcp", cidr_blocks = ["0.0.0.0/0"] },
    { description = "cloudflared-udp", from_port = 7844, to_port = 7844, protocol = "udp", cidr_blocks = ["0.0.0.0/0"] },
  ]

  tags = {
    Project     = "RegulAIt"
    Environment = "demo"
    Purpose     = "demo-host"
    ManagedBy   = "terraform"
    Stack       = "demo-host-host"
    Teardown    = var.teardown_after
    # DLM takes daily encrypted snapshots of every volume with this tag (detection.tf).
    Snapshot = "regulait-demo-host"
  }
}

# --- KMS: one customer-managed key for volumes, parameters, logs, backups -------

data "aws_iam_policy_document" "kms" {
  # Account administrators manage and use the key through IAM (the default
  # key-policy root statement); nothing outside this account is named.
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch Logs encrypts this stack's log groups (containers, Session
  # Manager transcripts, VPC flow logs) with this key, and nothing else.
  statement {
    sid       = "CloudWatchLogsForThisStacksLogGroups"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/regulait/demo-host/*"]
    }
  }
}

resource "aws_kms_key" "host" {
  description             = "RegulAIt demo host: EBS volumes, SSM parameters, container logs, backups (ADR-0228)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "host" {
  name          = "alias/regulait-demo-host"
  target_key_id = aws_kms_key.host.key_id
}

# --- container logs -------------------------------------------------------------

resource "aws_cloudwatch_log_group" "containers" {
  name              = var.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.host.arn
}

# --- the instance ---------------------------------------------------------------

module "app" {
  source = "../../../modules/app-instance"

  name     = local.name
  app_port = 3000 # informational: nothing is opened

  # No inbound rule at all (ADR-0228): SSM and the tunnel are outbound only.
  ingress_enabled = false

  boot_mode           = "host_only"
  kms_key_arn         = aws_kms_key.host.arn
  root_volume_size_gb = var.root_volume_size_gb
  data_volume_size_gb = var.data_volume_size_gb
  log_group_name      = aws_cloudwatch_log_group.containers.name
  swap_gb             = var.swap_gb

  # Latest AL2023 through the SSM public parameter when ami_id is null (the
  # default). Pinning it after the first apply stops a new AMI release from
  # proposing a replacement mid-demo; the data volume survives either way.
  ami_id        = var.ami_id
  instance_type = var.instance_type

  # Private subnet, no public IPv4, egress 443/tcp and 7844/tcp+udp only.
  vpc_id                      = module.vpc.vpc_id
  subnet_id                   = module.vpc.private_subnets[0]
  associate_public_ip_address = false
  egress_rules                = local.egress_rules
  # A demo host: termination protection off so teardown is one destroy.
  disable_api_termination = false

  source_bucket_name = "${local.name}-source-${local.account_id}"
  # The tunnel needs no stable public address: no Elastic IP.
  assign_elastic_ip = false

  tags = local.tags
}

# The instance's own extra permissions, each scoped to one resource. With
# AmazonSSMManagedInstanceCore (attached by the module) and the backup module's
# write-only grant, this is the role's whole policy. Beyond the security team's
# list (core, the parameter path, Decrypt on one key) it has only: read its own
# source bundle (module), write to two log groups, and write backups.
data "aws_iam_policy_document" "host" {
  statement {
    sid     = "ReadOwnParameters"
    actions = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
    resources = [
      "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}",
      "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }

  # SecureString parameters, Session Manager session data and the source bundle
  # are all encrypted with this one key.
  statement {
    sid       = "DecryptWithThisKeyOnly"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.host.arn]
  }

  statement {
    sid     = "WriteContainerAndSessionLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = [
      "${aws_cloudwatch_log_group.containers.arn}:*",
      "${aws_cloudwatch_log_group.sessions.arn}:*",
    ]
  }

  # The host timer (demo-host-anchor-creds.sh) assumes the anchor role and hands
  # its short-lived credentials to the gateway container (anchor.tf).
  statement {
    sid       = "AssumeAnchorRoleOnly"
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.anchor.arn]
  }

  # The SSM agent checks the session log group exists before streaming.
  statement {
    sid       = "FindLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "host" {
  name   = "demo-host-runtime"
  role   = module.app.instance_role_name
  policy = data.aws_iam_policy_document.host.json
}

# --- nightly encrypted backups (ADR-0035 pattern) ------------------------------
#
# The writer can put objects under its prefix and publish the heartbeat; it
# cannot read, list versions of, or delete any backup (modules/backup-target-s3).
# KMS here, unlike the dev stack: the bucket's encryption key is this stack's
# key, and the writer's grant on it is encrypt-only.
module "db_backup" {
  source = "../../../modules/backup-target-s3"

  name        = "${local.name}-db"
  bucket_name = "${local.name}-db-backup-${local.account_id}"
  prefix      = "postgres"

  writer_role_names = [module.app.instance_role_name]

  retention_days                    = var.backup_retention_days
  noncurrent_version_retention_days = 7

  enable_freshness_alarm = true
  # Daily backups on an always-on host: one missing day is already a fault.
  freshness_missing_days = 1
  alarm_sns_topic_arns   = var.backup_alarm_sns_topic_arns
  metric_namespace       = "RegulAIt/Backup"

  kms_key_arn = aws_kms_key.host.arn
}

# --- power schedule: present, OFF by default -------------------------------------
module "power_schedule" {
  source = "../../../modules/scheduled-power"

  name         = local.name
  instance_ids = [module.app.instance_id]

  enabled    = var.power_schedule_enabled
  start_cron = var.power_schedule_start_cron
  stop_cron  = var.power_schedule_stop_cron
  timezone   = var.power_schedule_timezone
}

# StartInstances on a CMK-encrypted instance needs a grant on that key; without
# it a scheduled start fails. Scoped to grants for AWS resources (EBS) only.
resource "aws_iam_role_policy" "scheduler_kms" {
  name = "start-encrypted-volumes"
  role = "${local.name}-scheduler"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["kms:CreateGrant"]
      Resource  = aws_kms_key.host.arn
      Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
    }]
  })
  depends_on = [module.power_schedule]
}
