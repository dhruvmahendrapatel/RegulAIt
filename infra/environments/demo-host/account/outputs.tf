output "host_account_id" {
  description = "Put this in ../baseline and ../host terraform.tfvars as host_account_id."
  value       = module.host_account.account_id
}

output "host_access_role_arn" {
  value = module.host_account.access_role_arn
}

output "budget_name" {
  value = module.host_account.budget_name
}

output "guardrails_policy_id" {
  value = module.host_account.guardrails_policy_id
}
