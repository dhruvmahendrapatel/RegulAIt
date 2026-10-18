output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "role_arn" {
  description = "The caller identity CloudTrail records for the planted calls."
  value       = aws_iam_role.lambda.arn
}

output "schedule_name" {
  value = aws_scheduler_schedule.this.name
}
