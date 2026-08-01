# backup-target-s3 — a hardened S3 destination for backups, plus the smallest
# IAM grant that lets a machine WRITE one and nothing else.
#
# The shape of the problem this solves: a box holds the only copy of some state.
# It needs to push a copy off-box on a schedule. It is also, by construction,
# the most likely thing to be compromised — it is the internet-facing machine.
# So the credential it uses must be able to ADD a backup and must NOT be able to
# read, overwrite-destructively, or delete one.
#
# WHAT THE WRITER CAN DO
#   s3:PutObject             on <bucket>/<prefix>/*      (upload a backup)
#   s3:AbortMultipartUpload  on <bucket>/<prefix>/*      (clean up its own failed upload)
#   s3:ListBucket            on <bucket>, prefix-limited (the on-box self-check)
#   cloudwatch:PutMetricData in one namespace            (the liveness heartbeat)
#
# WHAT THE WRITER CANNOT DO, and why that matters
#   s3:GetObject      — it cannot read back its own backups. An attacker with
#                       root on the box already has the LIVE database, so read
#                       access buys them nothing; denying it means the archive
#                       of PAST states (including rows since deleted) is not
#                       reachable from the compromised host.
#   s3:DeleteObject / s3:DeleteObjectVersion / s3:PutBucketVersioning /
#   s3:PutLifecycleConfiguration — it cannot destroy history, and cannot turn
#                       off the mechanisms that preserve it. Deletion is the
#                       lifecycle policy's job and only the lifecycle policy's.
#
# HONEST STATEMENT ABOUT OVERWRITE. PutObject on <prefix>/* DOES permit writing
# a key that already exists. An attacker with box access can therefore overwrite
# yesterday's backup with garbage, and can spray junk keys to run up the bill.
# What they CANNOT do is make the old bytes go away: versioning is on, an
# overwrite creates a new version and demotes the old one to noncurrent, and
# nothing this role holds can delete a version. Recovery from that attack is
# `aws s3api list-object-versions` + fetch the last good version — which is why
# the runbook is written around versions, not around keys. The residual damage
# is storage cost and confusion, not data loss.
#
# The bucket policy below re-states the deletion denials as an explicit Deny on
# the writer principals. That is deliberate belt-and-braces: an identity-policy
# Allow attached later (by a human, or by a stolen admin session) cannot
# override an explicit Deny in the resource policy.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  prefix = trim(var.prefix, "/")

  writer_role_arns = [
    for r in var.writer_role_names :
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${r}"
  ]

  # Every object this module expects to exist lives under here.
  object_arn_pattern = "${aws_s3_bucket.backup.arn}/${local.prefix}/*"
}

# --- the bucket ---------------------------------------------------------------

resource "aws_s3_bucket" "backup" {
  bucket = var.bucket_name

  # NOT force_destroy. `terraform destroy` on a stack whose only copy of the
  # database lives here must FAIL on a non-empty bucket rather than quietly
  # emptying it first. Removing this line is the single highest-consequence
  # edit in the module.
  force_destroy = false

  tags = merge(var.tags, { Name = var.bucket_name })
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket = aws_s3_bucket.backup.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs disabled entirely. With BucketOwnerEnforced there is no object-ACL path
# to public-read at all, so the public-access block above is defending a door
# that no longer exists.
resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Load-bearing, not hygiene: versioning is what converts "an attacker with
# PutObject overwrote the backup" from data loss into a recoverable nuisance.
# The writer role cannot suspend it (no s3:PutBucketVersioning anywhere, and an
# explicit Deny in the bucket policy below).
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    # Only meaningful for KMS: collapses per-object data-key calls to roughly
    # one per bucket per 5 minutes. Harmless (and ignored) under AES256.
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "expire-backups"
    status = "Enabled"

    filter {
      prefix = "${local.prefix}/"
    }

    expiration {
      days = var.retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  # A versioned bucket accumulates delete markers whose only remaining versions
  # have already expired. They are invisible in a plain `ls`, still count
  # against ListObjects, and never go away on their own. This must be its own
  # rule: `expired_object_delete_marker` and `days` are mutually exclusive
  # inside a single `expiration` block.
  rule {
    id     = "clean-expired-delete-markers"
    status = "Enabled"

    filter {
      prefix = "${local.prefix}/"
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.backup]
}

# --- resource policy: TLS-only, and deletion denied to the writers ------------

data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Belt-and-braces over the identity policy: an explicit resource-policy Deny
  # cannot be overridden by any Allow attached to the role later.
  dynamic "statement" {
    for_each = length(local.writer_role_arns) > 0 ? [1] : []

    content {
      sid    = "WritersMayNotDestroyHistory"
      effect = "Deny"

      principals {
        type        = "AWS"
        identifiers = local.writer_role_arns
      }

      actions = [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:DeleteBucket",
        "s3:DeleteBucketPolicy",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold",
      ]

      resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = data.aws_iam_policy_document.bucket.json

  # A bucket policy that names a principal is rejected while the public-access
  # block is still settling, and BlockPublicPolicy must be in place BEFORE a
  # policy is attached, never after.
  depends_on = [aws_s3_bucket_public_access_block.backup]
}

# --- the writer grant ---------------------------------------------------------

data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "PutBackupsUnderOnePrefixOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = [local.object_arn_pattern]
  }

  # Read-only, and confined to the prefix. This exists so the on-box
  # `--check` mode can answer "did today's backup actually land" without an
  # operator opening a console. It grants no ability to READ an object.
  statement {
    sid       = "ListOwnPrefixForSelfCheck"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backup.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.prefix}/*", "${local.prefix}/"]
    }
  }

  # The liveness heartbeat. Namespace-scoped: PutMetricData has no resource
  # ARN, so cloudwatch:namespace is the ONLY way to stop a compromised box
  # writing junk into every other namespace in the account.
  statement {
    sid       = "PublishBackupHeartbeatOnly"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.metric_namespace]
    }
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [1]

    content {
      sid    = "EncryptWithTheBucketKey"
      effect = "Allow"
      # Encrypt-only. Notably NOT kms:Decrypt — the writer cannot read back
      # what it wrote even if s3:GetObject were somehow granted.
      actions   = ["kms:GenerateDataKey", "kms:Encrypt", "kms:DescribeKey"]
      resources = [var.kms_key_arn]
    }
  }
}

resource "aws_iam_policy" "writer" {
  name        = "${var.name}-backup-writer"
  description = "Write-only access to s3://${var.bucket_name}/${local.prefix}/. No Get, no Delete."
  policy      = data.aws_iam_policy_document.writer.json
  tags        = var.tags
}

resource "aws_iam_role_policy_attachment" "writer" {
  for_each = toset(var.writer_role_names)

  role       = each.value
  policy_arn = aws_iam_policy.writer.arn
}

# --- freshness alarm ----------------------------------------------------------
#
# The classic backup failure is not a loud crash — it is a job that silently
# stops running and is discovered on the day it is needed. So the signal is
# inverted: the writer publishes a 1 on every VERIFIED upload, and the alarm
# fires on the ABSENCE of that 1.
#
# treat_missing_data = "breaching" is the whole point. A metric that stops being
# published must read as failure, not as "insufficient data" — the default
# behaviour would leave the alarm sitting in INSUFFICIENT_DATA forever, which is
# exactly the silence this is meant to break.
resource "aws_cloudwatch_metric_alarm" "freshness" {
  count = var.enable_freshness_alarm ? 1 : 0

  alarm_name = "${var.name}-backup-stale"
  alarm_description = join(" ", [
    "No verified backup uploaded to s3://${var.bucket_name}/${local.prefix}/ for",
    "${var.freshness_missing_days} consecutive day(s).",
    "Runbook: check the writer's log and `systemctl status` on the source host.",
  ])

  namespace   = var.metric_namespace
  metric_name = var.metric_name
  dimensions  = { Target = var.name }

  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = var.freshness_missing_days
  datapoints_to_alarm = var.freshness_missing_days
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = var.alarm_sns_topic_arns
  ok_actions    = var.alarm_sns_topic_arns

  tags = var.tags
}
