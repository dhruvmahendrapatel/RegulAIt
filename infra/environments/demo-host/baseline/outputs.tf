output "cloudtrail_bucket" {
  value = module.security_baseline.cloudtrail_bucket_name
}
output "cloudtrail_arn" {
  value = module.security_baseline.cloudtrail_arn
}
