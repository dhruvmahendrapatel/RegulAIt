# ADR-0029: the app is served over HTTPS at the sslip.io name derived from the
# instance's public IP. Plain http://<ip>:3000 no longer answers from off-box.
output "app_url" {
  value = "https://${module.app.sslip_hostname}"
}

output "tls_hostname" {
  value = module.app.sslip_hostname
}

output "public_ip" {
  value = module.app.public_ip
}

output "instance_id" {
  value = module.app.instance_id
}

output "source_bucket" {
  value = module.app.source_bucket
}

# --- scheduled power (ADR-0032) ----------------------------------------------

output "public_ip_is_stable" {
  description = "True once the Elastic IP is attached. If this is ever false while power_schedule is enabled, the sslip.io hostname and its certificate will break on the next stop/start."
  value       = module.app.public_ip_is_stable
}

output "power_window" {
  description = "The effective power schedule, in one line."
  value       = module.power_schedule.window_summary
}

output "power_schedule_names" {
  description = "EventBridge Scheduler schedule names, for one-off `aws scheduler update-schedule` overrides."
  value = {
    start = module.power_schedule.start_schedule_name
    stop  = module.power_schedule.stop_schedule_name
  }
}

# Copy-paste manual override. The box can always be started outside the window;
# it will still be stopped at the next stop-cron (see the module README).
output "manual_start_command" {
  value = "aws ec2 start-instances --instance-ids ${module.app.instance_id} --region ${var.aws_region} --profile ${var.workload_sso_profile}"
}

output "manual_stop_command" {
  value = "aws ec2 stop-instances --instance-ids ${module.app.instance_id} --region ${var.aws_region} --profile ${var.workload_sso_profile}"
}
