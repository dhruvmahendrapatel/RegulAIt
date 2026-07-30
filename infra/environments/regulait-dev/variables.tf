variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "management_sso_profile" {
  description = "aws configure sso profile name authenticated against the Management account, e.g. \"regulait-management\"."
  type        = string
}

variable "workload_sso_profile" {
  description = "aws configure sso profile name authenticated against the Workload (regulait-dev) account under Deploy-Builder, e.g. \"regulait-deploy\"."
  type        = string
}

variable "management_account_id" {
  type = string
}

variable "workload_account_id" {
  type = string
}

variable "organization_id" {
  type = string
}

variable "organization_root_id" {
  type = string
}

variable "allowed_regions" {
  type    = list(string)
  default = ["us-east-1", "us-east-2"]
}

variable "monthly_budget_usd" {
  description = "OQ-002 in project-state/STATE.md — confirm the real number with the user before applying."
  type        = number
  default     = 100
}

variable "budget_notification_emails" {
  type = list(string)
}

variable "enable_cis_standard" {
  description = "Set false to unsubscribe the AWS-auto-enabled CIS v1.2.0 Security Hub standard (noise suppression). One-time terraform import required first — see infra/modules/aws-security-baseline/main.tf."
  type        = bool
  default     = true
}

variable "user_principal_id" {
  description = "Identity Center user ID (aws identitystore list-users) to assign all three permission sets to."
  type        = string
}

variable "github_org" {
  type    = string
  default = "dhruvmahendrapatel"
}

variable "github_repo" {
  type    = string
  default = "RegulAIt"
}
