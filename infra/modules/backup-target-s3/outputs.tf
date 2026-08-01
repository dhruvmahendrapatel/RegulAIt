output "bucket" {
  description = "Bucket name backups are written to."
  value       = aws_s3_bucket.backup.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.backup.arn
}

output "prefix" {
  description = "Key prefix the writer is confined to (no slashes at either end)."
  value       = local.prefix
}

output "destination_uri" {
  description = "s3:// URI of the prefix. Paste-able into `aws s3 ls`."
  value       = "s3://${aws_s3_bucket.backup.bucket}/${local.prefix}/"
}

output "writer_policy_arn" {
  value = aws_iam_policy.writer.arn
}

output "metric_namespace" {
  value = var.metric_namespace
}

output "metric_name" {
  value = var.metric_name
}

output "metric_dimension_target" {
  description = "Value of the `Target` dimension the writer must publish with, or the freshness alarm never sees its heartbeat."
  value       = var.name
}

output "alarm_name" {
  description = "CloudWatch alarm name, or null when enable_freshness_alarm is false."
  value       = var.enable_freshness_alarm ? aws_cloudwatch_metric_alarm.freshness[0].alarm_name : null
}

output "alarm_notifies_anyone" {
  description = "False means the alarm exists and turns red in the console but sends no notification to any human. See alarm_sns_topic_arns."
  value       = var.enable_freshness_alarm && length(var.alarm_sns_topic_arns) > 0
}

output "retention_summary" {
  description = "The retention promise, in one line, for a runbook or an ADR."
  value       = "current versions expire after ${var.retention_days}d; noncurrent after ${var.noncurrent_version_retention_days}d; no principal holds s3:DeleteObject"
}
