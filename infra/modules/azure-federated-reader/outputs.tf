output "client_id" {
  description = "Application (client) id to give the federated workload."
  value       = azuread_application.this.client_id
}

output "tenant_id" {
  value = data.azuread_client_config.current.tenant_id
}

output "service_principal_object_id" {
  value = azuread_service_principal.this.object_id
}
