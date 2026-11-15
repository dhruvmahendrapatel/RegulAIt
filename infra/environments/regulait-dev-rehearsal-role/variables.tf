variable "workload_account_id" {
  description = "The regulait-dev workload account ID. Terraform refuses every other account. Keep it in terraform.tfvars, which is not committed."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "workload_account_id must be a 12-digit AWS account ID."
  }
}

variable "workload_sso_profile" {
  description = "AWS CLI profile of an Identity Center session in the regulait-dev account (aws sso login --profile <name>)."
  type        = string
}

variable "aws_region" {
  description = "Region the rehearsal runs in. Must be one of the Organization's allowed regions."
  type        = string
}

variable "github_org" {
  description = "Owner of the GitHub repository."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name."
  type        = string
}

variable "github_environment" {
  description = "GitHub deployment environment the role trusts. Create it with required reviewers before the first run."
  type        = string
  default     = "rehearsal"
}

variable "create_oidc_provider" {
  description = "false if the account already has the token.actions.githubusercontent.com provider; then pass its ARN."
  type        = bool
  default     = true
}

variable "existing_oidc_provider_arn" {
  type    = string
  default = null

  validation {
    condition     = var.existing_oidc_provider_arn == null || try(split(":", var.existing_oidc_provider_arn)[4] == var.workload_account_id, false)
    error_message = "existing_oidc_provider_arn must be a provider in the regulait-dev account (workload_account_id)."
  }
}

variable "github_repository_id" {
  description = "Recommended: the repository's numeric ID, so the role trusts the ID rather than the owner/name (a renamed or re-created repository cannot inherit it). Set the repository's OIDC subject template first (docs/ops/BYOC_REHEARSAL_ROLE.md, step 1b)."
  type        = number
  default     = null
}

variable "max_session_duration_seconds" {
  description = "Longest credential a rehearsal job can hold. EKS and RDS create and destroy take about an hour together."
  type        = number
  default     = 10800
}
