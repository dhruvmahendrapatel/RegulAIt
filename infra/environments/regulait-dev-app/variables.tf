variable "aws_region" {
  description = "Region for the app stack. Must be inside the security baseline's region allowlist."
  type        = string
  default     = "us-east-1"
}

variable "workload_sso_profile" {
  description = "AWS CLI SSO profile targeting the regulait-dev workload account."
  type        = string
  default     = "regulait-admin"
}

variable "instance_type" {
  description = "Instance type for the dev app box."
  type        = string
  default     = "t3.small"
}

variable "ingress_cidrs" {
  description = "Who can reach the app port. Open by default — this is a throwaway demo stack with key-gated APIs and per-deploy random secrets."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# --- scheduled power off/on (ADR-0032) ---------------------------------------
#
# Every knob is a variable on purpose: the schedule is an operator choice, not
# a property of the code, and it must be changeable without editing a module.

variable "assign_elastic_ip" {
  description = <<-EOT
    Pin the box's public IPv4 with an Elastic IP so it survives a stop/start.
    MUST stay true while power_schedule_enabled is true: this stack's hostname
    and Let's Encrypt certificate are derived from the address (ADR-0029), so an
    ephemeral IP plus a nightly power cycle means a new URL every morning.
  EOT
  type        = bool
  default     = true
}

variable "power_schedule_enabled" {
  description = <<-EOT
    Master switch for the automatic power schedule. false leaves both schedules
    in place but DISABLED (nothing is destroyed, the Elastic IP is untouched,
    and flipping back to true restores the same window). Use this — not deleting
    the module — to keep the box up for a stretch of days.
  EOT
  type        = bool
  default     = true
}

variable "power_schedule_start_cron" {
  description = "When the dev box powers ON. EventBridge Scheduler 6-field cron, evaluated in power_schedule_timezone. Default: 08:00 Mon-Fri."
  type        = string
  default     = "cron(0 8 ? * MON-FRI *)"
  nullable    = true
}

variable "power_schedule_stop_cron" {
  description = "When the dev box powers OFF. Same grammar/timezone as the start cron. Default: 20:00 Mon-Fri."
  type        = string
  default     = "cron(0 20 ? * MON-FRI *)"
  nullable    = true
}

variable "power_schedule_timezone" {
  description = <<-EOT
    IANA timezone the power crons are read in. Stated explicitly rather than
    assumed: the default window is 08:00-20:00 in America/New_York, which is
    also the region the stack runs in (us-east-1). EventBridge Scheduler handles
    DST natively, so the window stays at the same local time all year.
  EOT
  type        = string
  default     = "America/New_York"
}
