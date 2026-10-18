variable "aws_region" {
  description = "Region of every resource here; must be in the Organization's region allow-list SCP."
  type        = string
  default     = "us-east-1"
}

variable "management_sso_profile" {
  description = "AWS CLI Identity Center profile for the management account (it assumes into the sandbox)."
  type        = string
}

variable "sandbox_account_id" {
  description = "Output sandbox_account_id of ../account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.sandbox_account_id))
    error_message = "sandbox_account_id must be 12 digits."
  }
}

variable "sandbox_access_role_name" {
  type    = string
  default = "OrganizationAccountAccessRole"
}

variable "regulait_federation_issuer_url" {
  description = "RegulAIt's federation issuer: REGULAIT_PUBLIC_URL of the demo instance plus /federation (shown on the Cloud federation card)."
  type        = string
  validation {
    condition     = startswith(var.regulait_federation_issuer_url, "https://") && endswith(var.regulait_federation_issuer_url, "/federation")
    error_message = "regulait_federation_issuer_url must be https://<host>/federation (REGULAIT_PUBLIC_URL plus /federation)."
  }
}

variable "aws_discovery_source_id" {
  description = "Id of the cloud_aws discovery source created in RegulAIt; the role trusts only regulait:discovery-source:<id>."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.aws_discovery_source_id))
    error_message = "aws_discovery_source_id must be the source's UUID."
  }
}

variable "bedrock_model_id" {
  description = "On-demand Bedrock foundation model id the generators call. Pick the lowest-priced text model enabled for the account in this region. Set in terraform.tfvars."
  type        = string
}

variable "demo_company_slug" {
  description = "Fictional demo-company prefix for resource names (ADR-0197 decision 8)."
  type        = string
  default     = "larkfield"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.demo_company_slug))
    error_message = "demo_company_slug must be 3-21 lowercase letters, digits or hyphens."
  }
}

variable "schedule_timezone" {
  type    = string
  default = "America/New_York"
}

variable "activity_end_date" {
  description = "After this instant the generators never run again (RFC 3339, UTC)."
  type        = string
  default     = "2026-11-30T23:59:59Z"
}

variable "activity_enabled" {
  description = "false pauses both generators without destroying anything."
  type        = bool
  default     = true
}

variable "teardown_after" {
  type    = string
  default = "2026-11-30"
}
