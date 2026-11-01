output "cloudtrail_bucket" {
  value = module.security_baseline.cloudtrail_bucket_name
}
output "cloudtrail_arn" {
  value = module.security_baseline.cloudtrail_arn
}

output "host_role_boundary_arn" {
  description = "Every role the demo-host deployer creates must carry this boundary (the host stack reads it by name)."
  value       = aws_iam_policy.host_role_boundary.arn
}

output "host_backend_hcl" {
  description = "Contents of ../host/backend.hcl (git-ignored). The profile is the deployer's Identity Center profile in the host account."
  value = join("\n", [
    "bucket         = \"${aws_s3_bucket.host_state.bucket}\"",
    "key            = \"demo-host/host/terraform.tfstate\"",
    "dynamodb_table = \"${aws_dynamodb_table.host_state_lock.name}\"",
    "kms_key_id     = \"${aws_kms_key.host_state.arn}\"",
    "region         = \"${var.aws_region}\"",
    "encrypt        = true",
    "profile        = \"regulait-demo-host\"",
    "",
  ])
}
