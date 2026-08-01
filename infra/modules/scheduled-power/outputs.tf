output "scheduler_role_arn" {
  description = "Role EventBridge Scheduler assumes. Grants ONLY ec2:StartInstances/StopInstances on the listed instances."
  value       = aws_iam_role.scheduler.arn
}

output "stop_schedule_name" {
  description = "Name of the stop schedule, or null when stop_cron is null. Use with `aws scheduler update-schedule` for a one-off override."
  value       = var.stop_cron == null ? null : aws_scheduler_schedule.stop[0].name
}

output "start_schedule_name" {
  description = "Name of the start schedule, or null when start_cron is null."
  value       = var.start_cron == null ? null : aws_scheduler_schedule.start[0].name
}

output "stop_schedule_arn" {
  value       = var.stop_cron == null ? null : aws_scheduler_schedule.stop[0].arn
  description = "ARN of the stop schedule, or null when stop_cron is null."
}

output "start_schedule_arn" {
  value       = var.start_cron == null ? null : aws_scheduler_schedule.start[0].arn
  description = "ARN of the start schedule, or null when start_cron is null."
}

# A single human-readable line, so `terraform output` answers "what is the
# window actually set to right now" without anyone re-deriving it from crons.
output "window_summary" {
  description = "Human-readable summary of the effective power window."
  value = format(
    "%s | start=%s | stop=%s | tz=%s | instances=%s",
    var.enabled ? "ENABLED" : "DISABLED",
    coalesce(var.start_cron, "(none)"),
    coalesce(var.stop_cron, "(none)"),
    var.timezone,
    join(",", var.instance_ids),
  )
}

output "governed_instance_arns" {
  description = "Exact instance ARNs the scheduler role is scoped to."
  value       = local.instance_arns
}
