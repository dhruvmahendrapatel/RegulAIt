variable "name" {
  description = "Server name (globally unique in Azure: 3-63 lowercase letters, digits, hyphens)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.name))
    error_message = "name must be 3-63 lowercase letters, digits or hyphens."
  }
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "delegated_subnet_id" {
  description = "A subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers. The server gets no public endpoint."
  type        = string
}

variable "private_dns_zone_id" {
  description = "The private DNS zone (*.postgres.database.azure.com) linked to the virtual network."
  type        = string
}

variable "postgres_version" {
  type    = string
  default = "16"
}

variable "sku_name" {
  description = "A General Purpose or Memory Optimized SKU: Burstable SKUs do not support high availability."
  type        = string
  default     = "GP_Standard_D4ds_v5"

  validation {
    condition     = !startswith(var.sku_name, "B_")
    error_message = "Burstable SKUs cannot run a high-availability standby; use GP_ or MO_."
  }
}

variable "storage_mb" {
  type    = number
  default = 65536
}

variable "zone" {
  description = "The primary's availability zone."
  type        = string
  default     = "1"
}

variable "high_availability" {
  description = "ZoneRedundant: a synchronous standby in another zone with automatic failover (RPO 0, ADR-0343). SameZone protects against a node loss only. Disabled removes high availability."
  type        = string
  default     = "ZoneRedundant"

  validation {
    condition     = contains(["ZoneRedundant", "SameZone", "Disabled"], var.high_availability)
    error_message = "high_availability must be ZoneRedundant, SameZone or Disabled."
  }
}

variable "standby_zone" {
  description = "The standby's zone for ZoneRedundant; it must differ from zone."
  type        = string
  default     = "2"
}

variable "backup_retention_days" {
  description = "Days of backups and point-in-time recovery."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 7-35 (the Azure range)."
  }
}

variable "geo_redundant_backup" {
  description = "Copy backups to the paired region, for a restore after region loss (RPO about 5 minutes). Needs geo_backup_key_vault_key_id."
  type        = bool
  default     = true
}

variable "administrator_login" {
  type    = string
  default = "app_admin"
}

variable "administrator_password_wo" {
  description = "The administrator password, write-only: it is sent to Azure and never stored in Terraform state or plan. Read it from Key Vault through an ephemeral resource."
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "administrator_password_version" {
  description = "Bump to rotate administrator_password_wo."
  type        = number
  default     = 1
}

variable "entra_tenant_id" {
  description = "Entra ID tenant for token sign-in, which is enabled alongside the password."
  type        = string
}

variable "user_assigned_identity_id" {
  description = "A user-assigned identity with get, wrapKey and unwrapKey on the keys below."
  type        = string
}

variable "key_vault_key_id" {
  description = "Customer-managed key for data at rest."
  type        = string
}

variable "geo_backup_user_assigned_identity_id" {
  description = "Identity in the paired region for the geo-backup key. Required when geo_redundant_backup is on."
  type        = string
  default     = null
}

variable "geo_backup_key_vault_key_id" {
  description = "Customer-managed key in the paired region. Required when geo_redundant_backup is on."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "A CanNotDelete management lock on the server. Turn off only for a disposable rehearsal."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
