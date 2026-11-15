variable "account_id" {
  description = "The AWS account to install into. Terraform refuses every other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  type = string
}

variable "name_prefix" {
  type    = string
  default = "regulait"
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = { project = "regulait", managed-by = "terraform" }
}

variable "vpc_cidr" {
  type    = string
  default = "10.60.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "egress_mode" {
  type    = string
  default = "allow_list"
}

variable "egress_allowed_domains" {
  type    = list(string)
  default = ["login.microsoftonline.com"]
}

variable "log_retention_days" {
  type    = number
  default = 365
}

variable "kubernetes_version" {
  type    = string
  default = "1.34"
}

variable "cluster_endpoint_public_access_cidrs" {
  type    = list(string)
  default = []
}

variable "cluster_admin_principal_arns" {
  type    = list(string)
  default = []
}

variable "node_instance_types" {
  type    = list(string)
  default = ["m7i.large"]
}

variable "node_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "db_skip_final_snapshot" {
  type    = bool
  default = false
}

variable "audit_object_lock_mode" {
  type    = string
  default = "COMPLIANCE"
}

variable "audit_retention_days" {
  type    = number
  default = 2555
}

variable "bedrock_model_ids" {
  type    = list(string)
  default = []
}

variable "iam_permissions_boundary_arn" {
  type    = string
  default = null
}
