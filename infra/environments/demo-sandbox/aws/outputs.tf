output "discovery_role_arn" {
  description = "Credential public config `roleArn` of the cloud_aws discovery source."
  value       = module.discovery_role.role_arn
}

output "regulait_source_target" {
  description = "Target fields for the cloud_aws discovery source (one key=value per line on the Discovery sources page)."
  value = {
    accountId         = var.sandbox_account_id
    stsRegion         = data.aws_region.current.region
    trailBucket       = module.trail.bucket_name
    trailBucketRegion = module.trail.bucket_region
  }
}

output "regulait_source_scope_regions" {
  value = [data.aws_region.current.region]
}

output "planted_callers" {
  description = "The role ARNs a scan should report as callers of Bedrock."
  value       = [module.generator_support.role_arn, module.generator_invoices.role_arn]
}

output "planted_guardrail_arn" {
  value = aws_bedrock_guardrail.planted.guardrail_arn
}
