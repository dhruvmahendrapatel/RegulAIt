variable "name" {
  description = "Instance name (lowercase letters, digits, hyphens; Cloud SQL does not reuse a name for about a week after deletion)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.name))
    error_message = "name must be 3-63 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "private_network" {
  description = "The VPC network self link, with private services access configured. The instance gets no public IP."
  type        = string
}

variable "database_version" {
  type    = string
  default = "POSTGRES_16"
}

variable "tier" {
  description = "A dedicated-core machine type: shared-core tiers do not support high availability."
  type        = string
  default     = "db-custom-4-16384"

  validation {
    condition     = !contains(["db-f1-micro", "db-g1-small"], var.tier)
    error_message = "Shared-core tiers cannot run a high-availability standby."
  }
}

variable "disk_size_gb" {
  type    = number
  default = 50
}

variable "availability_type" {
  description = "REGIONAL: a synchronous standby in a second zone with automatic failover (RPO 0, ADR-0343). ZONAL removes high availability."
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "ZONAL"], var.availability_type)
    error_message = "availability_type must be REGIONAL or ZONAL."
  }
}

variable "kms_key_name" {
  description = "Customer-managed key (projects/…/locations/<region>/keyRings/…/cryptoKeys/…) in the instance's region. The Cloud SQL service agent needs encrypter/decrypter on it."
  type        = string

  validation {
    condition     = can(regex("^projects/[^/]+/locations/[^/]+/keyRings/[^/]+/cryptoKeys/[^/]+$", var.kms_key_name))
    error_message = "kms_key_name must be a full Cloud KMS crypto key name."
  }
}

variable "backup_retention_count" {
  description = "Daily backups kept."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_count >= 7 && var.backup_retention_count <= 365
    error_message = "backup_retention_count must be 7-365."
  }
}

variable "transaction_log_retention_days" {
  description = "Days of write-ahead log kept for point-in-time recovery."
  type        = number
  default     = 7

  validation {
    condition     = var.transaction_log_retention_days >= 1 && var.transaction_log_retention_days <= 7
    error_message = "transaction_log_retention_days must be 1-7 (the Cloud SQL range for PostgreSQL Enterprise)."
  }
}

variable "root_password_wo" {
  description = "The `postgres` user's password, write-only: never stored in Terraform state or plan. Read it from Secret Manager through an ephemeral resource."
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "root_password_version" {
  description = "Bump to rotate root_password_wo."
  type        = number
  default     = 1
}

variable "dr_replica" {
  description = "An optional cross-region read replica, for region loss (RPO about 5 minutes, asynchronous). It is promoted by hand. kms_key_name must be a key in dr_region."
  type = object({
    region       = string
    kms_key_name = string
  })
  default = null
}

variable "deletion_protection" {
  description = "Refuse to delete the instance (both the Terraform guard and the Cloud SQL API guard). Turn off only for a disposable rehearsal."
  type        = bool
  default     = true
}

variable "labels" {
  type    = map(string)
  default = {}
}
