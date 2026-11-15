output "rehearsal_role_arn" {
  description = "Set this as the REHEARSAL_ROLE_ARN variable of the GitHub `rehearsal` environment (Settings > Environments). Do not commit it."
  value       = module.github_oidc.environment_role_arns["rehearsal"]
}

output "boundary_policy_arn" {
  value = module.deployer_policy.boundary_policy_arn
}

output "stack_name_prefix" {
  description = "Names the rehearsal stack must use."
  value       = "regulait-rehearsal"
}
