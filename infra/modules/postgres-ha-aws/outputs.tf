output "endpoint" {
  description = "The writer endpoint (host:port). It follows the primary through a failover."
  value       = module.db.db_instance_endpoint
}

output "address" {
  description = "The writer host name."
  value       = module.db.db_instance_address
}

output "db_instance_arn" {
  description = "For cross-region backup replication (modules/cross-region-backups)."
  value       = module.db.db_instance_arn
}

output "master_user_secret_arn" {
  description = "The Secrets Manager secret RDS keeps the master password in."
  value       = module.db.db_instance_master_user_secret_arn
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "multi_az" {
  value = var.multi_az
}
