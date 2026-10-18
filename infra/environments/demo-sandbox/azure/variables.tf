variable "tenant_id" {
  description = "Entra tenant id. Set in terraform.tfvars (git-ignored)."
  type        = string
}

variable "subscription_id" {
  description = "Subscription the demo resource group is created in. Set in terraform.tfvars."
  type        = string
}

variable "location" {
  description = "Region offering the chosen model and deployment type."
  type        = string
  default     = "eastus"
}

variable "regulait_federation_issuer_url" {
  description = "RegulAIt's federation issuer: REGULAIT_PUBLIC_URL of the demo instance plus /federation."
  type        = string
  validation {
    condition     = startswith(var.regulait_federation_issuer_url, "https://") && endswith(var.regulait_federation_issuer_url, "/federation")
    error_message = "regulait_federation_issuer_url must be https://<host>/federation."
  }
}

variable "azure_discovery_source_id" {
  description = "Id of the cloud_azure discovery source created in RegulAIt."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.azure_discovery_source_id))
    error_message = "azure_discovery_source_id must be the source's UUID."
  }
}

variable "grant_activity_log_read" {
  description = "Also grant an activity-log-only role at subscription scope. The scanner reads the activity log per subscription, which Reader on the resource group does not cover; false means that read is reported as denied."
  type        = bool
  default     = true
}

variable "openai_model_name" {
  description = "Azure OpenAI model name available in the region (lowest-priced chat model). Set in terraform.tfvars."
  type        = string
}

variable "openai_model_version" {
  description = "Its version as Azure OpenAI lists it. Set in terraform.tfvars."
  type        = string
}

variable "openai_deployment_sku" {
  type    = string
  default = "GlobalStandard"
}

variable "openai_token_limit_field" {
  description = "max_tokens, or max_completion_tokens for models that only accept that."
  type        = string
  default     = "max_tokens"
}

variable "activity_enabled" {
  description = "false pauses the Logic App without destroying anything."
  type        = bool
  default     = true
}

variable "budget_amount" {
  description = "Resource-group budget from budget_start_date, in the billing currency. The default 10 is the Azure share of the ADR-0197 USD 50 ceiling (AWS takes 40); if the billing currency is not USD, set the equivalent of USD 10 or less."
  type        = number
  default     = 10
}

variable "budget_start_date" {
  type    = string
  default = "2026-10-01T00:00:00Z"
}

variable "budget_contact_emails" {
  description = "Who the budget notifies. Set in terraform.tfvars."
  type        = list(string)
}

variable "demo_company_slug" {
  description = "Fictional demo-company prefix for resource names (ADR-0197 decision 8)."
  type        = string
  default     = "larkfield"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,12}$", var.demo_company_slug))
    error_message = "demo_company_slug must be 3-13 lowercase letters or digits (it is part of a global subdomain)."
  }
}

variable "teardown_after" {
  type    = string
  default = "2026-11-30"
}
