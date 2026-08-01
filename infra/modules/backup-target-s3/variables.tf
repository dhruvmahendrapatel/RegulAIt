variable "name" {
  description = "Name prefix for the IAM policy, the CloudWatch alarm, and the metric dimension. Must be unique within the account."
  type        = string
}

variable "bucket_name" {
  description = "Name of the S3 bucket this module creates. S3 bucket names are globally unique, so the caller supplies it (convention: <stack>-backup-<account-id>)."
  type        = string
}

variable "prefix" {
  description = <<-EOT
    Key prefix every backup object lives under, with no leading or trailing
    slash. The writer's IAM permissions are scoped to exactly this prefix, so a
    writer cannot put objects anywhere else in the bucket. One bucket can
    therefore serve several independent writers, each confined to its own
    prefix. This module CREATES the bucket, so several writers sharing one
    bucket means one module instance and several entries in
    `writer_role_names`. Genuinely separate prefixes want separate buckets.
  EOT
  type        = string
  default     = "backups"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$", var.prefix))
    error_message = "prefix must not start or end with a slash and must be a plain S3 key prefix."
  }
}

variable "writer_role_names" {
  description = <<-EOT
    IAM role NAMES (not ARNs) that get write-only access to `prefix`. Typically
    exactly one: the instance role of the box being backed up. These roles get
    PutObject and nothing that can read or destroy an existing backup — see
    README.md for the exact grant and the threat model it is built against.
  EOT
  type        = list(string)
  default     = []
}

variable "retention_days" {
  description = <<-EOT
    How long a CURRENT backup object is kept before the lifecycle rule expires
    it. This is the module's only deletion mechanism: no principal is granted
    s3:DeleteObject, so the retention window is enforced by S3 rather than by
    anything that could be tricked into running early.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.retention_days >= 1
    error_message = "retention_days must be at least 1."
  }
}

variable "noncurrent_version_retention_days" {
  description = <<-EOT
    How long a NONCURRENT version is kept. Versioning is on, so overwriting an
    existing key does not lose the old bytes — it pushes them to noncurrent.
    This is what bounds the cost of an attacker (or a bug) overwriting the same
    key repeatedly. Keep it shorter than retention_days.
  EOT
  type        = number
  default     = 7
}

variable "abort_incomplete_multipart_days" {
  description = "Days before an incomplete multipart upload is aborted. Incomplete parts are invisible in ListObjects but ARE billed."
  type        = number
  default     = 7
}

variable "kms_key_arn" {
  description = <<-EOT
    Customer-managed KMS key to encrypt objects with. null (the default) means
    SSE-S3 (AES256), which is free. Set this only when a compliance regime
    demands a key whose grants you control: a CMK costs $1/month plus per-request
    charges, and for a bucket whose only reader is the same account's admin it
    buys no additional isolation.
  EOT
  type        = string
  default     = null
}

variable "enable_freshness_alarm" {
  description = "Create a CloudWatch alarm that fires when the writer stops reporting successful backups. See freshness_missing_days."
  type        = bool
  default     = true
}

variable "metric_namespace" {
  description = "CloudWatch namespace the writer publishes its success metric into. The writer's IAM grant is conditioned on exactly this namespace."
  type        = string
  default     = "Backup"
}

variable "metric_name" {
  description = "CloudWatch metric name the writer publishes: 1 on a verified upload, 0 on any failure."
  type        = string
  default     = "BackupSuccess"
}

variable "freshness_missing_days" {
  description = <<-EOT
    Consecutive 24-hour periods with no successful backup before the alarm
    fires. This is deliberately > 1: a box that is powered off at weekends
    (see infra/modules/scheduled-power) legitimately misses two days in a row,
    and an alarm that cries wolf every Saturday is an alarm nobody reads.
    3 is the smallest value that survives a weekend. It is also, stated
    plainly, the detection latency: a backup that stops working on Monday is
    noticed on Thursday.
  EOT
  type        = number
  default     = 3

  validation {
    condition     = var.freshness_missing_days >= 1
    error_message = "freshness_missing_days must be at least 1."
  }
}

variable "alarm_sns_topic_arns" {
  description = <<-EOT
    SNS topics notified when the freshness alarm changes state. EMPTY BY
    DEFAULT, and an empty list means the alarm is visible in the CloudWatch
    console and nowhere else — it emails nobody. That is a real limitation, not
    a placeholder: creating a topic here would still notify nobody until a human
    confirmed a subscription, so the module refuses to imply coverage it does
    not have. Pass a topic ARN to make it actually page someone.
  EOT
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
