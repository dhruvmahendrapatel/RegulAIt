# audit-anchor-worm-s3 — an S3 Object Lock (COMPLIANCE mode) destination for
# ADR-0060 audit-chain head anchors, plus the smallest IAM grant that lets a
# machine add one and nothing else.
#
# NOTHING HERE HAS BEEN APPLIED TO ANY AWS ACCOUNT. This module is written,
# reviewed and committed; creating the bucket is a separate, explicitly
# authorised act. Object Lock in COMPLIANCE mode is irreversible — see the
# warning block below before anyone runs `terraform apply`.
#
# ---------------------------------------------------------------------------
# WHY THIS IS A SIBLING OF backup-target-s3 AND NOT THE SAME BUCKET
# ---------------------------------------------------------------------------
# ADR-0035's bucket answers "we lost the database". This one answers "somebody
# edited the database and we need to prove it". They are different controls with
# different threat models and, critically, different DELETION semantics:
#
#   backup-target-s3   lifecycle EXPIRES objects after retention_days, because a
#                      backup that is never deleted is a bill and a liability.
#   this module        objects CANNOT be deleted before their retention expires,
#                      by anyone, including the account root and including us.
#
# Putting both in one bucket would mean either backups that cannot be aged out
# or anchors that can be deleted. Neither is acceptable, so: two buckets.
#
# ---------------------------------------------------------------------------
# WHAT COMPLIANCE MODE ACTUALLY MEANS, STATED BEFORE ANYONE ENABLES IT
# ---------------------------------------------------------------------------
# In COMPLIANCE mode, for the length of the retention period:
#   * no principal can delete the object version — not the IAM user, not an
#     admin, not the account ROOT, not AWS Support;
#   * the retention period cannot be shortened, only extended;
#   * the only way to stop paying for it is to close the AWS account.
# That is the entire point: an adversary who owns the database and the app
# credentials still cannot rewrite the anchored head. It is also a real,
# unrescindable financial and operational commitment, which is why
# `object_lock_mode` defaults to GOVERNANCE (which a holder of
# s3:BypassGovernanceRetention can override) and COMPLIANCE must be chosen
# explicitly by a human who has read this paragraph.
#
# GOVERNANCE mode is NOT equivalent. It stops accidents and casual insiders; it
# does not stop an attacker who has, or can grant themselves, the bypass
# permission. An install that wants the ADR-0060 guarantee against a hostile DB
# admin wants COMPLIANCE. The module makes both possible and neither implicit.
#
# ---------------------------------------------------------------------------
# BYOC (ADR-0041 / ADR-0060 §8.5)
# ---------------------------------------------------------------------------
# In the primary motion this bucket lives in the CUSTOMER's account under their
# IAM, exactly like the ADR-0035 backup target. The customer, not us, holds the
# immutable anchor — which is the stronger trust story for a sovereignty buyer,
# because it means even RegulAIt cannot rewrite their evidence. This module
# takes no provider block for that reason: the caller supplies the account.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  prefix             = trim(var.prefix, "/")
  object_arn_pattern = "${aws_s3_bucket.anchors.arn}/${local.prefix}/*"

  writer_role_arns = [
    for r in var.writer_role_names :
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${r}"
  ]
}

# --- the bucket ---------------------------------------------------------------

# object_lock_enabled CANNOT be turned on after creation, and cannot be turned
# off after it. It is a create-time property of the bucket.
resource "aws_s3_bucket" "anchors" {
  bucket              = var.bucket_name
  object_lock_enabled = true

  # NOT force_destroy. With Object Lock on, `terraform destroy` on a non-empty
  # bucket MUST fail rather than attempt an emptying pass that would, for
  # COMPLIANCE-mode objects, fail anyway — noisily, half-way through, leaving a
  # confusing mess. Removing this line is the highest-consequence edit here.
  force_destroy = false

  tags = merge(var.tags, { Name = var.bucket_name, Purpose = "audit-chain-anchors" })
}

# Object Lock requires versioning, and versioning can never be suspended on a
# lock-enabled bucket. Stated explicitly rather than left implicit.
resource "aws_s3_bucket_versioning" "anchors" {
  bucket = aws_s3_bucket.anchors.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "anchors" {
  bucket = aws_s3_bucket.anchors.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.anchors]
}

resource "aws_s3_bucket_public_access_block" "anchors" {
  bucket                  = aws_s3_bucket.anchors.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "anchors" {
  bucket = aws_s3_bucket.anchors.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "anchors" {
  bucket = aws_s3_bucket.anchors.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

# DELIBERATELY NO LIFECYCLE EXPIRATION RULE. On a COMPLIANCE-mode bucket an
# expiration rule cannot delete a locked version anyway; adding one would create
# the false impression that anchors age out. They do not, until their retention
# lapses. Anchors are a few hundred bytes each, so an hourly cadence is ~9 MB a
# decade — the cost argument that justifies lifecycle rules on the backup bucket
# simply does not arise here.

# --- the writer grant ---------------------------------------------------------

# WHAT THE WRITER CAN DO
#   s3:PutObject             on <bucket>/<prefix>/*   (write an anchor)
#   s3:ListBucket            on <bucket>, prefix-limited (the on-box self-check)
#
# WHAT IT CANNOT DO, and why each denial matters
#   s3:DeleteObject / s3:DeleteObjectVersion
#       — the whole point. Object Lock already refuses this; the explicit Deny
#         means a later identity-policy Allow (added by a human, or by a stolen
#         admin session) still cannot get through, because an explicit Deny in a
#         resource policy beats any Allow.
#   s3:PutObjectRetention / s3:PutObjectLegalHold / s3:BypassGovernanceRetention
#       — it cannot shorten its own retention, and cannot bypass GOVERNANCE mode.
#         Without this, a GOVERNANCE-mode bucket would be decorative for exactly
#         the adversary this control exists for.
#   s3:PutBucketObjectLockConfiguration / s3:PutBucketVersioning
#       — it cannot weaken the mechanism it is writing into.
#   s3:GetObject
#       — it does not need to read anchors back to write new ones, and the
#         verifier that DOES read them is a separate, human-initiated act with a
#         separate credential. A compromised gateway host therefore cannot even
#         enumerate what the true history was.
data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "PutAnchorOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [local.object_arn_pattern]
  }

  statement {
    sid       = "ListOwnPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.anchors.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.prefix}/*"]
    }
  }
}

resource "aws_iam_policy" "writer" {
  count       = length(var.writer_role_names) > 0 ? 1 : 0
  name        = "${var.name}-anchor-writer"
  description = "ADR-0060: write audit-chain head anchors to ${var.bucket_name}/${local.prefix} and nothing else."
  policy      = data.aws_iam_policy_document.writer.json
}

resource "aws_iam_role_policy_attachment" "writer" {
  for_each   = length(var.writer_role_names) > 0 ? toset(var.writer_role_names) : toset([])
  role       = each.value
  policy_arn = aws_iam_policy.writer[0].arn
}

# Belt-and-braces: re-state the destructive denials as an explicit Deny on the
# writer principals in the RESOURCE policy, where no later identity-policy Allow
# can override them.
data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.anchors.arn, "${aws_s3_bucket.anchors.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = length(local.writer_role_arns) > 0 ? [1] : []
    content {
      sid    = "WriterMayNeverDestroyOrWeaken"
      effect = "Deny"
      principals {
        type        = "AWS"
        identifiers = local.writer_role_arns
      }
      actions = [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold",
        "s3:BypassGovernanceRetention",
        "s3:PutBucketObjectLockConfiguration",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
      ]
      resources = [aws_s3_bucket.anchors.arn, "${aws_s3_bucket.anchors.arn}/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "anchors" {
  bucket = aws_s3_bucket.anchors.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.anchors]
}
