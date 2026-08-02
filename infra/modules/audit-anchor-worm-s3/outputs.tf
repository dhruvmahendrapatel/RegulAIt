output "bucket" {
  description = "Bucket name anchors are written to."
  value       = aws_s3_bucket.anchors.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.anchors.arn
}

output "prefix" {
  description = "Key prefix the writer is confined to (no slashes at either end)."
  value       = local.prefix
}

output "destination_uri" {
  description = "s3:// URI of the prefix. Paste-able into `aws s3 ls`."
  value       = "s3://${aws_s3_bucket.anchors.bucket}/${local.prefix}/"
}

output "object_lock_mode" {
  description = "GOVERNANCE or COMPLIANCE, as actually configured. Read this before claiming ADR-0060's guarantee against a hostile administrator — only COMPLIANCE delivers it."
  value       = var.object_lock_mode
}

output "retention_days" {
  description = "Days each anchor is locked for. Must match or exceed the deployment's audit-log retention, or anchors expire before the rows they pin."
  value       = var.retention_days
}

output "writer_policy_arn" {
  description = "ARN of the write-only IAM policy, or null when no writer roles were supplied."
  value       = length(aws_iam_policy.writer) > 0 ? aws_iam_policy.writer[0].arn : null
}
