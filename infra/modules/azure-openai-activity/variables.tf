variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "resource_group_name" {
  type = string
}

variable "resource_group_id" {
  description = "Id of the same resource group, for the budget."
  type        = string
}

variable "location" {
  description = "Azure region; the chosen model and SKU must be offered there."
  type        = string
}

variable "custom_subdomain_name" {
  description = "Globally unique subdomain of the account endpoint (required for Entra authentication)."
  type        = string
}

variable "deployment_name" {
  type    = string
  default = "chat"
}

variable "model_name" {
  description = "Model name as Azure OpenAI lists it for the region. Supplied at apply time."
  type        = string
}

variable "model_version" {
  description = "Model version as Azure OpenAI lists it for the region. Supplied at apply time."
  type        = string
}

variable "deployment_sku" {
  description = "Pay-per-token deployment type (Standard or GlobalStandard; never a provisioned SKU)."
  type        = string
  default     = "GlobalStandard"
  validation {
    condition     = contains(["Standard", "GlobalStandard", "DataZoneStandard"], var.deployment_sku)
    error_message = "Only pay-per-token deployment types are allowed here."
  }
}

variable "deployment_capacity" {
  description = "Rate limit in thousands of tokens per minute."
  type        = number
  default     = 1
}

variable "api_version" {
  description = "Azure OpenAI data-plane API version the generator calls."
  type        = string
  default     = "2024-10-21"
}

variable "prompt" {
  description = "The prompt the generator sends. Keep it free of personal data."
  type        = string
}

variable "max_tokens" {
  description = "Output token limit per call."
  type        = number
  default     = 32
  validation {
    condition     = var.max_tokens >= 1 && var.max_tokens <= 128
    error_message = "max_tokens must be between 1 and 128."
  }
}

variable "token_limit_field" {
  description = "Request field that carries the output token limit (some newer models only accept max_completion_tokens)."
  type        = string
  default     = "max_tokens"
  validation {
    condition     = contains(["max_tokens", "max_completion_tokens"], var.token_limit_field)
    error_message = "token_limit_field must be max_tokens or max_completion_tokens."
  }
}

variable "recurrence_interval_hours" {
  description = "Hours between generator runs (one call per run)."
  type        = number
  default     = 3
  validation {
    condition     = var.recurrence_interval_hours >= 1
    error_message = "Run at most once an hour."
  }
}

variable "generator_enabled" {
  description = "false keeps the Logic App but stops it running."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "log_daily_quota_gb" {
  description = "Hard daily ingestion cap for the workspace, in GB."
  type        = number
  default     = 0.1
}

variable "budget_amount" {
  description = "Budget for the resource group from budget_start_date, in the billing currency."
  type        = number
}

variable "budget_start_date" {
  description = "First day of a month, RFC 3339 (e.g. 2026-10-01T00:00:00Z)."
  type        = string
}

variable "budget_alert_threshold_percent" {
  type    = number
  default = 80
}

variable "budget_contact_emails" {
  description = "Who the budget notifies. Supplied at apply time, never committed."
  type        = list(string)
  validation {
    condition     = length(var.budget_contact_emails) >= 1
    error_message = "Give at least one budget contact."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
