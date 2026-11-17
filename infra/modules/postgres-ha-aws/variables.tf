variable "name" {
  description = "Identifier for the database and the names of everything this module creates (lowercase letters, digits, hyphens)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,46}[a-z0-9]$", var.name))
    error_message = "name must be 3-48 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "vpc_id" {
  description = "The VPC the database lives in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets in at least two availability zones, for the subnet group this module creates. The standby is placed in a different zone from the primary. Not used when db_subnet_group_name is set."
  type        = list(string)
  default     = []

  validation {
    condition     = var.db_subnet_group_name != null || length(var.subnet_ids) >= 2
    error_message = "Give at least two subnets, in different availability zones (a Multi-AZ standby needs a second zone), or an existing db_subnet_group_name."
  }
}

variable "db_subnet_group_name" {
  description = "An existing DB subnet group to use instead of creating one (for example a VPC module's database subnet group). It must span at least two availability zones."
  type        = string
  default     = null
}

variable "allowed_security_group_ids" {
  description = "Security groups whose members may connect on 5432 (the application's nodes or tasks). Nothing else can."
  type        = list(string)

  validation {
    condition     = length(var.allowed_security_group_ids) >= 1
    error_message = "Name at least one security group that may connect; the database has no other ingress."
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for storage, the master-password secret, Performance Insights and the log group."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "engine_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "16"
}

variable "instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "allocated_storage_gb" {
  type    = number
  default = 50
}

variable "database_name" {
  type    = string
  default = "app"
}

variable "master_username" {
  type    = string
  default = "app_admin"
}

variable "multi_az" {
  description = "A synchronous standby in a second zone with automatic failover (RPO 0, ADR-0343). Turning it off removes high availability."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Days of automated backups and point-in-time recovery."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 1-35 (0 would turn backups and point-in-time recovery off)."
  }
}

variable "deletion_protection" {
  description = "Refuse to delete the database. Turn off only for a disposable rehearsal."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Delete without a final snapshot. Only for a disposable rehearsal."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 365
}

variable "iam_permissions_boundary_arn" {
  description = "Permissions boundary for the enhanced-monitoring role, when the account requires one."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "resource_name_prefix" {
  description = "Prefix for the security group and monitoring role names. Defaults to name; a caller with existing state passes the prefix it already used."
  type        = string
  default     = null
}

variable "security_group_description" {
  description = "Description of the database security group (changing it replaces the group)."
  type        = string
  default     = "PostgreSQL from the named security groups only."
}

variable "ingress_description" {
  description = "Description on each 5432 ingress rule."
  type        = string
  default     = "PostgreSQL"
}
