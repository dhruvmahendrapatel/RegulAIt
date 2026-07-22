variable "project" {
  type    = string
  default = "regulait"
}

variable "workload_account_id" {
  description = "Account the three permission sets get assigned against."
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
