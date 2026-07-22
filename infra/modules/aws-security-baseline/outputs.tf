output "cloudtrail_bucket_name" {
  value = aws_s3_bucket.cloudtrail.id
}

output "cloudtrail_arn" {
  value = aws_cloudtrail.org.arn
}

output "config_aggregator_name" {
  value = aws_config_configuration_aggregator.org.name
}

output "deploy_builder_boundary_policy_arn" {
  description = "Attach this as the permissions boundary on the Deploy-Builder permission set and any CI role."
  value       = aws_iam_policy.deploy_builder_boundary.arn
}

output "deploy_builder_boundary_policy_name" {
  description = "Bare policy name (not ARN) — needed for aws_ssoadmin_permissions_boundary_attachment's customer_managed_policy_reference."
  value       = aws_iam_policy.deploy_builder_boundary.name
}
