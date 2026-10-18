output "regulait_source_target" {
  description = "Target fields for the cloud_azure discovery source."
  value = {
    tenantId                 = module.discovery_reader.tenant_id
    logAnalyticsWorkspaceIds = module.openai_activity.log_analytics_workspace_guid
  }
}

output "regulait_source_scope_subscriptions" {
  value = [var.subscription_id]
}

output "regulait_credential_public_config" {
  description = "Credential public config of the cloud_azure discovery source (federated)."
  value = {
    tenantId = module.discovery_reader.tenant_id
    clientId = module.discovery_reader.client_id
  }
}

output "planted_openai_account_id" {
  value = module.openai_activity.account_id
}

output "planted_caller_principal_id" {
  description = "The Logic App's managed identity, the caller of the planted calls."
  value       = module.openai_activity.generator_principal_id
}
