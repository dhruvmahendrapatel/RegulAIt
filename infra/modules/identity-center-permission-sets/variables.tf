variable "project" {
  type    = string
  default = "regulait"
}

variable "workload_account_id" {
  description = "Account Deploy-Builder is assigned against, and where Admin-BreakGlass/ReadOnly-Audit are also assigned."
  type        = string
}

variable "management_account_id" {
  description = "Admin-BreakGlass and ReadOnly-Audit are also assigned here — org-wide resources (CloudTrail org trail, GuardDuty/SecurityHub org config, SCPs, Budgets) live in Management, so the foundation role needs access to both accounts. Deploy-Builder intentionally stays workload-only."
  type        = string
}

variable "user_principal_id" {
  description = "Identity Center user ID (not the email) that gets all three permission sets assigned. Find with `aws identitystore list-users`."
  type        = string
}

variable "deploy_builder_boundary_policy_arn" {
  description = "Output of the aws-security-baseline module — attached as the permissions boundary on Deploy-Builder."
  type        = string
}

variable "deploy_builder_boundary_policy_name" {
  description = "Name (not ARN) of the same policy, needed for the customer-managed-policy-reference attachment."
  type        = string
}
