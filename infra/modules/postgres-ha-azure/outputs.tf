output "fqdn" {
  description = "The server's private host name. It follows the primary through a failover."
  value       = azurerm_postgresql_flexible_server.this.fqdn
}

output "id" {
  value = azurerm_postgresql_flexible_server.this.id
}

output "high_availability" {
  value = var.high_availability
}
