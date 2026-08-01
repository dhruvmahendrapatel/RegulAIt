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

# --- database backup (ADR-0035) ----------------------------------------------
#
# Same principle as the power schedule above: every operator choice is a
# variable. Retention, the alarm threshold and the schedule are policy, not
# code, and none of them should require editing a module to change.

variable "backup_retention_days" {
  description = <<-EOT
    How long a nightly pg_dump is kept in S3 before the bucket's lifecycle rule
    expires it. 30 days is the deliberate dev-stack choice: long enough that a
    corruption noticed "some time last month" is still recoverable, short enough
    that the bucket cannot grow without bound. Nothing on the box can delete a
    backup early — the instance role holds no s3:DeleteObject — so this number
    is the ONLY deletion mechanism.
  EOT
  type        = number
  default     = 30
}

variable "backup_noncurrent_retention_days" {
  description = "How long an overwritten (noncurrent) backup version is kept. Bounds the cost of an attacker with box access spraying overwrites; keep well under backup_retention_days."
  type        = number
  default     = 7
}

variable "backup_alarm_enabled" {
  description = "Create the CloudWatch 'no successful backup for N days' alarm. The alarm fires on the ABSENCE of the writer's heartbeat, which is the failure mode that actually happens."
  type        = bool
  default     = true
}

variable "backup_alarm_missing_days" {
  description = <<-EOT
    Consecutive days with no successful backup before the alarm fires. 3, not 1,
    because ADR-0032 powers the box off at weekends and a two-day gap is normal
    — an alarm that reddens every Saturday is an alarm nobody reads. Stated
    plainly: this is also the detection latency.
  EOT
  type        = number
  default     = 3
}

variable "backup_alarm_sns_topic_arns" {
  description = <<-EOT
    SNS topics the freshness alarm notifies. EMPTY BY DEFAULT — with no topic
    the alarm turns red in the CloudWatch console and emails nobody. That is the
    honest current posture, not an oversight: a topic created here would still
    notify nobody until a human confirmed a subscription, so the stack does not
    pretend to have paging it does not have. See docs/ops/DB_BACKUP.md.
  EOT
  type        = list(string)
  default     = []
}

variable "backup_enabled" {
  description = <<-EOT
    Whether the on-box timer should be ENABLED when pg-backup.sh installs
    itself. This flows into the generated /etc/regulait-pg-backup.env (see the
    `backup_env_file` output), NOT into any AWS resource — turning it off leaves
    the bucket, its contents and the IAM grant completely untouched.
  EOT
  type        = bool
  default     = true
}

variable "backup_oncalendar" {
  description = <<-EOT
    systemd OnCalendar expression for the backup timer.

    WHY 17:00 UTC. ADR-0032 stops the box at 20:00 and starts it at 08:00
    America/New_York on weekdays, so anything scheduled outside that window
    simply never runs. 17:00 UTC is 13:00 local under EDT and 12:00 local under
    EST — mid-window in both halves of the year, ~4h after the box comes up and
    ~7h before it goes down. Naming the instant in UTC (rather than in a local
    timezone, which needs systemd 252+) means it cannot drift out of the window
    when the clocks change.

    WHY DAILY. On a weekday-only box the weekend elapses are missed; the timer's
    Persistent=true then fires one catch-up run just after Monday's boot. That
    is a free extra restore point and a weekly proof the timer is still alive,
    and it also covers a manual start outside the window.
  EOT
  type        = string
  default     = "*-*-* 17:00:00 UTC"
}
