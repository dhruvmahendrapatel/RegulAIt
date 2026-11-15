output "oidc_provider_arn" {
  value = local.provider_arn
}

output "plan_role_arn" {
  value = var.create_branch_roles ? aws_iam_role.plan[0].arn : null
}

output "deploy_role_arn" {
  value = var.create_branch_roles ? aws_iam_role.deploy[0].arn : null
}

output "environment_role_arns" {
  description = "Environment role ARNs, keyed like var.environment_roles."
  value       = { for k, r in aws_iam_role.environment : k => r.arn }
}
