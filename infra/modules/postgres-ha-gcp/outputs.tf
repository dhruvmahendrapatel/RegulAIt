output "connection_name" {
  description = "project:region:instance, for the Cloud SQL connector. It follows the primary through a zone failover."
  value       = google_sql_database_instance.primary.connection_name
}

output "private_ip_address" {
  value = google_sql_database_instance.primary.private_ip_address
}

output "dr_replica_connection_name" {
  value = var.dr_replica == null ? null : google_sql_database_instance.dr_replica[0].connection_name
}

output "availability_type" {
  value = var.availability_type
}
