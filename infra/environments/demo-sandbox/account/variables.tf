variable "aws_region" {
  description = "Region for the provider (Organizations and Budgets are global; this only picks endpoints)."
  type        = string
  default     = "us-east-1"
}

variable "management_sso_profile" {
  description = "AWS CLI Identity Center profile for the company (management) account."
  type        = string
}

variable "management_account_id" {
  description = "The company account's id (the Organization's management account). The provider refuses any other account. Set in terraform.tfvars, never committed."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.management_account_id))
    error_message = "management_account_id must be 12 digits."
  }
}

variable "allowed_regions" {
  description = "Regions the sandbox guardrail SCP allows. Keep equal to bedrock_allowed_regions in ../aws, and include that stack's aws_region."
  type        = list(string)
  default     = ["us-east-1", "us-east-2"]
}

variable "account_name" {
  description = "Name of the sandbox account."
  type        = string
  default     = "regulait-demo-sandbox"
}

variable "account_email" {
  description = "Root email of the sandbox account (unique across AWS). Set it in terraform.tfvars, which is never committed."
  type        = string
}

variable "parent_id" {
  description = "OU id for the account; null places it at the Organization root (where the baseline SCPs attach)."
  type        = string
  default     = null
}

variable "budget_limit_usd" {
  description = "Total AWS budget for the sandbox from budget_period_start. ADR-0197 decision 4 caps AWS plus Azure at USD 50 in total, so the strict default is 40 here and 10 in the azure stack; raising either breaks that ceiling."
  type        = number
  default     = 40
}

variable "budget_period_start" {
  description = "Budget start, AWS Budgets format."
  type        = string
  default     = "2026-10-01_00:00"
}

variable "budget_notification_emails" {
  description = "Who receives the 80% alert, the forecast alert and the spend-cap notice. Set in terraform.tfvars."
  type        = list(string)
}

variable "teardown_after" {
  description = "Date after which the sandbox is torn down (a tag, so the console shows it)."
  type        = string
  default     = "2026-11-30"
}
