output "sandbox_account_id" {
  description = "Put this in ../aws/terraform.tfvars as sandbox_account_id."
  value       = module.sandbox_account.account_id
}

output "sandbox_access_role_arn" {
  value = module.sandbox_account.access_role_arn
}

output "budget_name" {
  value = module.sandbox_account.budget_name
}

output "spend_cap_policy_id" {
  description = "Attached automatically at 100% of the budget. Detaching it by hand lifts the cap."
  value       = module.sandbox_account.spend_cap_policy_id
}

output "guardrails_policy_id" {
  description = "Guardrail SCP attached to the sandbox account (region allow-list, no LeaveOrganization, no StopLogging or DeleteTrail)."
  value       = module.sandbox_account.guardrails_policy_id
}
