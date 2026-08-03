variable "name" {
  description = "Name prefix for the IAM policy. Must be unique within the account."
  type        = string
}

variable "bucket_name" {
  description = <<-EOT
    Name of the S3 bucket this module creates. S3 bucket names are globally
    unique, so the caller supplies it (convention:
    <stack>-audit-anchors-<account-id>).

    Object Lock is a CREATE-TIME property. If this bucket already exists without
    it, the name cannot be reused — pick a new one.
  EOT
  type        = string
}

variable "prefix" {
  description = "Key prefix every anchor object lives under, no leading or trailing slash. The writer's grant is scoped to exactly this prefix."
  type        = string
  default     = "audit-anchors"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$", var.prefix))
    error_message = "prefix must not start or end with a slash and must be a plain S3 key prefix."
  }
}

variable "object_lock_mode" {
  description = <<-EOT
    GOVERNANCE or COMPLIANCE.

    GOVERNANCE (the default) stops accidents and casual insiders. A principal
    holding s3:BypassGovernanceRetention CAN still delete a locked object, so it
    does NOT deliver ADR-0060's guarantee against a hostile administrator.

    COMPLIANCE is what ADR-0060 actually asks for: for the retention period, NO
    principal can delete or shorten the object — not an admin, not the account
    root, not AWS Support. It is irreversible and it is a real financial
    commitment. It is not the default precisely because a module should not
    make that commitment on a human's behalf.
  EOT
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.object_lock_mode)
    error_message = "object_lock_mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "retention_days" {
  description = <<-EOT
    Days each anchor object is locked for.

    ADR-0060's compliance-cascade note: this is a compliance-relevant parameter,
    not a performance dial. It should MATCH OR EXCEED the audit-log retention
    the deployment's classification requires — an anchor that expires before the
    rows it pins leaves those rows unprovable, which is worse than obvious.

    365 is a starting point, not a recommendation for a regulated workload.
  EOT
  type        = number
  default     = 365

  validation {
    condition     = var.retention_days >= 1
    error_message = "retention_days must be at least 1."
  }
}

variable "writer_role_names" {
  description = <<-EOT
    IAM role NAMES (not ARNs) granted PutObject on `prefix` and nothing else —
    typically the single instance role of the control-plane host. They are also
    explicitly DENIED every deletion, retention-shortening and lock-weakening
    action in the bucket policy, so a later identity-policy Allow cannot
    resurrect those permissions.
  EOT
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for object encryption. null (default) means SSE-S3. Anchors contain no secrets — they are hashes — so a CMK buys key-grant control, not confidentiality that was otherwise missing."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
