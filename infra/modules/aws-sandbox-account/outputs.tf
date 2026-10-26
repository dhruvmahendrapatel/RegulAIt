output "account_id" {
  description = "The new account's id."
  value       = aws_organizations_account.this.id
}

output "access_role_arn" {
  description = "Role the management account assumes to manage resources inside the account."
  value       = "arn:aws:iam::${aws_organizations_account.this.id}:role/${var.access_role_name}"
}

output "budget_name" {
  value = aws_budgets_budget.this.name
}

output "spend_cap_policy_id" {
  description = "The SCP AWS Budgets attaches at 100% (null when the cap is off). Detach it by hand to lift the cap."
  value       = var.enable_spend_cap ? aws_organizations_policy.spend_cap[0].id : null
}

output "guardrails_policy_id" {
  description = "The guardrail SCP attached to the account (null when off)."
  value       = var.enable_guardrails ? aws_organizations_policy.guardrails[0].id : null
}
