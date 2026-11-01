variable "aws_region" {
  description = "Region of the host. Must be in the guardrail SCP's allowed_regions."
  type        = string
  default     = "us-east-1"
}

variable "management_sso_profile" {
  description = "AWS CLI Identity Center profile for the company (management) account."
  type        = string
}

variable "host_account_id" {
  description = "The demo-host account id (output host_account_id of ../account). terraform.tfvars only."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.host_account_id))
    error_message = "host_account_id must be 12 digits."
  }
}

variable "host_access_role_name" {
  type    = string
  default = "OrganizationAccountAccessRole"
}

variable "vpc_id" {
  description = "VPC for the host. Empty uses the account's default VPC (a public subnet: the instance has a public IPv4 for outbound traffic only, and no inbound rule)."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "t3.xlarge (4 vCPU, 16 GiB): the full demo stack, built on the host, with headroom. See DEMO_RUNBOOK §8.12 for the cost."
  type        = string
  default     = "t3.xlarge"
}

variable "ami_id" {
  description = "Pin to the AMI the instance runs after the first apply (the module explains why). Null resolves the latest AL2023 on the first apply."
  type        = string
  default     = null
}

variable "root_volume_size_gb" {
  description = "Root volume: OS, images and build cache."
  type        = number
  default     = 40
}

variable "data_volume_size_gb" {
  description = "Encrypted data volume mounted at /var/lib/docker: every Docker volume, Postgres included."
  type        = number
  default     = 60
}

variable "swap_gb" {
  type    = number
  default = 4
}

variable "log_group_name" {
  description = "CloudWatch log group for container logs."
  type        = string
  default     = "/regulait/demo-host/containers"
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "backup_retention_days" {
  type    = number
  default = 30
}

variable "backup_oncalendar" {
  description = "systemd OnCalendar for the nightly pg_dump (UTC)."
  type        = string
  default     = "*-*-* 07:00:00 UTC"
}

variable "backup_alarm_sns_topic_arns" {
  description = "SNS topics notified when backups stop. Empty: the alarm turns red in the console and notifies nobody."
  type        = list(string)
  default     = []
}

variable "power_schedule_enabled" {
  description = "OFF by default (ADR-0228): the demo host must not sleep through the demo. Turn on only after the demo, if the host is kept."
  type        = bool
  default     = false
}

variable "power_schedule_start_cron" {
  type    = string
  default = "cron(0 8 ? * MON-FRI *)"
}

variable "power_schedule_stop_cron" {
  type    = string
  default = "cron(0 20 ? * MON-FRI *)"
}

variable "power_schedule_timezone" {
  type    = string
  default = "America/New_York"
}

variable "teardown_after" {
  type    = string
  default = "2026-11-30"
}
