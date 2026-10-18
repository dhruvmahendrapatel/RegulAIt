variable "account_name" {
  description = "Name of the new member account; also prefixes the budget, the spend-cap SCP and the budget-action role."
  type        = string
}

variable "account_email" {
  description = "Root email address of the new account. Must be unique across AWS. Supplied at apply time; never committed."
  type        = string
}

variable "parent_id" {
  description = "Organization root or OU id to place the account in. null means the Organization root."
  type        = string
  default     = null
}

variable "access_role_name" {
  description = "Role Organizations creates in the account for the management account to assume."
  type        = string
  default     = "OrganizationAccountAccessRole"
}

variable "close_on_deletion" {
  description = "Close the account when this resource is destroyed (teardown). false only removes it from the Organization's state, which would leave it billing."
  type        = bool
  default     = true
}

variable "budget_limit_usd" {
  description = "Total budget for the account from budget_period_start, in USD."
  type        = number
  validation {
    condition     = var.budget_limit_usd > 0
    error_message = "budget_limit_usd must be positive."
  }
}

variable "budget_period_start" {
  description = "Start of the budget period, in the AWS Budgets format YYYY-MM-DD_hh:mm (UTC)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}:[0-9]{2}$", var.budget_period_start))
    error_message = "budget_period_start must look like 2026-10-01_00:00."
  }
}

variable "budget_alert_threshold_percent" {
  description = "Actual-spend percentage of the budget that emails the subscribers."
  type        = number
  default     = 80
}

variable "budget_notification_emails" {
  description = "Who the budget alerts and the spend-cap action notify. At least one; supplied at apply time, never committed."
  type        = list(string)
  validation {
    condition     = length(var.budget_notification_emails) >= 1 && length(var.budget_notification_emails) <= 10
    error_message = "Give between 1 and 10 notification addresses."
  }
}

variable "enable_spend_cap" {
  description = "At 100% of the budget, AWS Budgets automatically attaches an SCP denying spend_cap_denied_actions to the account."
  type        = bool
  default     = true
}

variable "spend_cap_denied_actions" {
  description = "Actions the spend-cap SCP denies once the budget is used up."
  type        = list(string)
  # Converse and ConverseStream are authorised as InvokeModel and
  # InvokeModelWithResponseStream, so those two cover all four runtime calls.
  default = [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:InvokeAgent",
    "bedrock:CreateProvisionedModelThroughput",
    "lambda:InvokeFunction",
    "sagemaker:CreateEndpoint",
  ]
}

variable "tags" {
  description = "Tags for every resource. A production designation is refused."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for k, v in var.tags : !can(regex("(?i)^(prod|production)$", v)) && !can(regex("(?i)^(prod|production)$", k))
    ])
    error_message = "A sandbox account never carries a prod or production tag."
  }
}
