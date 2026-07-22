output "cloudtrail_arn" {
  value = module.security_baseline.cloudtrail_arn
}

output "deploy_builder_permission_set_arn" {
  value = module.identity_center.deploy_builder_permission_set_arn
}
