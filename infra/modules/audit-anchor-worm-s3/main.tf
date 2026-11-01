# audit-anchor-worm-s3 — an S3 Object Lock (COMPLIANCE mode) destination for
# ADR-0060 audit-chain head anchors, plus the smallest IAM grant that lets the
# gateway's S3ObjectLockSink write an anchor, read it back and grade the lock,
# and nothing else.
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
data "aws_region" "current" {}

locals {
  prefix             = trim(var.prefix, "/")
  object_arn_pattern = "${aws_s3_bucket.anchors.arn}/${local.prefix}/*"

  # COMPLIANCE is always acceptable (it is the strongest mode, and the one the
  # sink writes); GOVERNANCE only on a bucket whose own default is GOVERNANCE.
  permitted_lock_modes = distinct(["COMPLIANCE", var.object_lock_mode])
  retention_floor_days = max(var.retention_days - 1, 0)

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

# Sized to the exact calls the gateway's S3ObjectLockSink makes
# (apps/gateway/src/audit-chain.ts), and nothing more (ADR-0060 amendment
# 2026-11-01). Until that date this grant was PutObject only and the bucket
# policy denied s3:PutObjectRetention, so every locked PUT the sink makes was
# refused and the sink could not read the lock configuration that grades it.
#
# WHAT THE WRITER CAN DO
#   s3:PutObject, s3:PutObjectRetention          on <bucket>/<prefix>/*
#       — the sink PUTs each anchor with ObjectLockMode=COMPLIANCE and an
#         explicit ObjectLockRetainUntilDate, and S3 authorises a PUT that
#         carries retention as PutObjectRetention too.
#   s3:GetObject, s3:GetObjectVersion, s3:GetObjectRetention
#                                                on <bucket>/<prefix>/*
#       — the sink reads the anchor back BY VERSION (the first version of a key,
#         so a later masking write cannot substitute a forged head) and reads
#         that version's retain-until date for /v1/audit/verify.
#   s3:ListBucket, s3:ListBucketVersions         on <bucket>, prefix-limited
#       — ListObjectVersions under <prefix>/ to find the latest anchor.
#   s3:GetBucketObjectLockConfiguration          on <bucket>
#       — the call that GRADES tamper resistance. The grade is read from
#         the bucket, never configured, so without this the gateway reports the
#         anchor as NOT tamper-resistant even on a COMPLIANCE bucket.
#   kms:GenerateDataKey, kms:Decrypt             on kms_key_arn, only when set
#       — through S3 only (kms:ViaService) and only for this bucket
#         (kms:EncryptionContext:aws:s3:arn). SSE-KMS needs GenerateDataKey to
#         write and Decrypt to read back.
#
# WHAT IT CANNOT DO — enforced as an explicit Deny in the BUCKET policy below,
# where no later identity-policy Allow can override it:
#   delete any object version; bypass GOVERNANCE retention; place or lift a legal
#   hold; change the bucket's Object Lock configuration, versioning, lifecycle or
#   policy; delete the bucket; and — the narrowing that replaced the blanket
#   PutObjectRetention deny — write a retention in a weaker mode than the
#   bucket's, or shorter than retention_days.
#
# WHY READ ACCESS IS NOW GRANTED. The earlier design kept reads on a separate,
# human-initiated verifier credential so a compromised gateway host could not
# enumerate the true history. The sink as built verifies on the gateway itself
# (ADR-0189 R44: read back the version written), so it needs reads. Anchors are
# hashes, not data, and reading them cannot alter them; what a compromised host
# gains is knowledge of the head it would have to forge, which the Object Lock
# makes unforgeable anyway.
data "aws_iam_policy_document" "writer" {
  statement {
    sid    = "WriteAndReadBackAnchors"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:PutObjectRetention",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectRetention",
    ]
    resources = [local.object_arn_pattern]
  }

  statement {
    sid       = "ListOwnPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.anchors.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.prefix}/*"]
    }
  }

  statement {
    sid       = "ReadLockConfiguration"
    effect    = "Allow"
    actions   = ["s3:GetBucketObjectLockConfiguration"]
    resources = [aws_s3_bucket.anchors.arn]
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [1]
    content {
      sid       = "UseBucketKeyThroughS3Only"
      effect    = "Allow"
      actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
      resources = [var.kms_key_arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${data.aws_region.current.name}.amazonaws.com"]
      }
      # With bucket_key_enabled the context is the bucket ARN; the object ARN
      # covers a request S3 makes without the bucket key.
      condition {
        test     = "StringLike"
        variable = "kms:EncryptionContext:aws:s3:arn"
        values   = [aws_s3_bucket.anchors.arn, "${aws_s3_bucket.anchors.arn}/*"]
      }
    }
  }
}

resource "aws_iam_policy" "writer" {
  count       = length(var.writer_role_names) > 0 ? 1 : 0
  name        = "${var.name}-anchor-writer"
  description = "ADR-0060: write and read back audit-chain head anchors under ${var.bucket_name}/${local.prefix}; no delete, bypass or weakening."
  policy      = data.aws_iam_policy_document.writer.json
}

resource "aws_iam_role_policy_attachment" "writer" {
  for_each   = length(var.writer_role_names) > 0 ? toset(var.writer_role_names) : toset([])
  role       = each.value
  policy_arn = aws_iam_policy.writer[0].arn
}

# Belt-and-braces: state the destructive and weakening denials as an explicit
# Deny on the writer principals in the RESOURCE policy, where no later
# identity-policy Allow can override them.
#
# s3:PutObjectRetention IS NOT IN THE BLANKET DENY ANY MORE, and that is safe
# (ADR-0060 amendment 2026-11-01). The sink cannot write a locked anchor without
# it. What the old deny was protecting against is covered instead:
#
#   Shortening an EXISTING version's retention.
#     COMPLIANCE: S3 itself refuses to shorten or remove it, for every principal.
#     GOVERNANCE: S3 refuses to shorten or remove it unless the request carries
#       x-amz-bypass-governance-retention AND the caller holds
#       s3:BypassGovernanceRetention, which stays explicitly denied below. So in
#       both modes the writer can only EXTEND a retention (or raise GOVERNANCE to
#       COMPLIANCE), which strengthens the lock.
#
#   Writing a NEW version with a weaker lock than the bucket default. An
#     explicit mode/retain-until on a PUT overrides the bucket default, so
#     without a guard a stolen writer credential could write anchors in
#     GOVERNANCE mode on a COMPLIANCE bucket, or with a one-day retention.
#     WriterLockModeNoWeakerThanBucket and WriterRetentionNoShorterThanBucket
#     refuse exactly that. Both match only when the request CARRIES the header
#     (the Null=false condition), so a plain PUT that takes the bucket default
#     is unaffected.
#
# The retention floor allows one day of slack below retention_days so that
# clock skew and S3's whole-day rounding of the remaining days cannot refuse a
# sink configured to exactly retention_days. Corollary for the operator: the
# gateway's REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS must be >= retention_days,
# or every anchor write is refused (loudly — the anchor row records `failed`).
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
        "s3:PutObjectLegalHold",
        "s3:BypassGovernanceRetention",
        "s3:PutBucketObjectLockConfiguration",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:DeleteBucket",
      ]
      resources = [aws_s3_bucket.anchors.arn, "${aws_s3_bucket.anchors.arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = length(local.writer_role_arns) > 0 ? [1] : []
    content {
      sid    = "WriterLockModeNoWeakerThanBucket"
      effect = "Deny"
      principals {
        type        = "AWS"
        identifiers = local.writer_role_arns
      }
      actions   = ["s3:PutObject", "s3:PutObjectRetention"]
      resources = ["${aws_s3_bucket.anchors.arn}/*"]
      condition {
        test     = "Null"
        variable = "s3:object-lock-mode"
        values   = ["false"]
      }
      condition {
        test     = "StringNotEquals"
        variable = "s3:object-lock-mode"
        values   = local.permitted_lock_modes
      }
    }
  }

  dynamic "statement" {
    for_each = length(local.writer_role_arns) > 0 ? [1] : []
    content {
      sid    = "WriterRetentionNoShorterThanBucket"
      effect = "Deny"
      principals {
        type        = "AWS"
        identifiers = local.writer_role_arns
      }
      actions   = ["s3:PutObject", "s3:PutObjectRetention"]
      resources = ["${aws_s3_bucket.anchors.arn}/*"]
      condition {
        test     = "Null"
        variable = "s3:object-lock-remaining-retention-days"
        values   = ["false"]
      }
      condition {
        test     = "NumericLessThan"
        variable = "s3:object-lock-remaining-retention-days"
        values   = [tostring(local.retention_floor_days)]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "anchors" {
  bucket = aws_s3_bucket.anchors.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.anchors]
}
