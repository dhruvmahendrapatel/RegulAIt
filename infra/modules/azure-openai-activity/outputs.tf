output "account_id" {
  value = azurerm_cognitive_account.this.id
}

output "endpoint" {
  value = azurerm_cognitive_account.this.endpoint
}

output "log_analytics_workspace_guid" {
  description = "The workspace GUID a Log Analytics query names (not the ARM id)."
  value       = azurerm_log_analytics_workspace.this.workspace_id
}

output "log_analytics_workspace_resource_id" {
  value = azurerm_log_analytics_workspace.this.id
}

output "generator_principal_id" {
  description = "The managed identity the planted calls are made under."
  value       = azurerm_logic_app_workflow.generator.identity[0].principal_id
}
