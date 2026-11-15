output "kubeconfig_command" {
  value = module.byoc.kubeconfig_command
}

output "cluster_name" {
  value = module.byoc.cluster_name
}

output "db_endpoint" {
  value = module.byoc.db_endpoint
}

output "db_master_secret_arn" {
  value = module.byoc.db_master_secret_arn
}

output "audit_bucket" {
  value = module.byoc.audit_bucket
}

output "gateway_role_arn" {
  value = module.byoc.gateway_role_arn
}

output "ecr_repository_urls" {
  value = module.byoc.ecr_repository_urls
}

output "ecr_public_cache_prefix" {
  value = module.byoc.ecr_public_cache_prefix
}

output "egress" {
  value = module.byoc.egress
}

output "storage_class_manifest" {
  value = module.byoc.storage_class_manifest
}

output "helm_values" {
  value = module.byoc.helm_values
}

output "gateway_environment" {
  value = module.byoc.gateway_environment
}

output "data_boundary" {
  value = module.byoc.data_boundary
}

output "region" {
  value = module.byoc.region
}

output "kms_key_arn" {
  value = module.byoc.kms_key_arn
}

output "lb_controller_helm_values" {
  value = module.byoc.lb_controller_helm_values
}

output "ingress_manifest" {
  value = module.byoc.ingress_manifest
}
