variable "aws_region" {
  description = "Region for the provider (Organizations and Budgets are global)."
  type        = string
  default     = "us-east-1"
}

variable "management_sso_profile" {
  description = "AWS CLI Identity Center profile for the company (management) account."
  type        = string
}

variable "management_account_id" {
  description = "The company account's id. The provider refuses any other account. terraform.tfvars only, never committed."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.management_account_id))
    error_message = "management_account_id must be 12 digits."
  }
}

variable "allowed_regions" {
  description = "Regions the guardrail SCP allows. Must include the host stack's aws_region."
  type        = list(string)
  default     = ["us-east-1", "us-east-2"]
}

variable "account_name" {
  description = "Name of the demo-host member account."
  type        = string
  default     = "regulait-demo-host"
}

variable "account_email" {
  description = "Root email of the new account (unique across AWS). terraform.tfvars only."
  type        = string
}

variable "parent_id" {
  description = "OU id for the account; null places it at the Organization root."
  type        = string
  default     = null
}

variable "budget_limit_usd" {
  description = "Budget for the demo-host account from budget_period_start; the 80% alert and the forecast alert go to budget_notification_emails. Separate from the sandbox's USD 50 cap (ADR-0197). The default covers about two months of the default instance size (DEMO_RUNBOOK §8 i)."
  type        = number
  default     = 100
}

variable "budget_period_start" {
  description = "Budget start, AWS Budgets format."
  type        = string
  default     = "2026-11-01_00:00"
}

variable "budget_notification_emails" {
  description = "Who receives the budget alerts. terraform.tfvars only."
  type        = list(string)
}

variable "teardown_after" {
  description = "Date the host is torn down by (a tag, a reminder; nothing acts on it)."
  type        = string
  default     = "2026-11-30"
}
