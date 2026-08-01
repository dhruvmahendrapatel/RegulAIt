variable "name" {
  description = "Name prefix for every resource this module creates (IAM role, both schedules)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$", var.name))
    error_message = "name must be 1-49 chars of [A-Za-z0-9._-] and start alphanumeric (EventBridge Scheduler name limit is 64, leaving room for the -start/-stop suffix)."
  }
}

variable "instance_ids" {
  description = <<-EOT
    EC2 instance IDs this schedule powers off and on. Every ID is turned into a
    concrete instance ARN in the IAM policy — the scheduler role can never touch
    an instance that is not in this list, and there is no `Resource: "*"`.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.instance_ids) > 0
    error_message = "instance_ids must contain at least one instance ID; an empty list would create a role with an unsatisfiable policy."
  }

  validation {
    condition     = alltrue([for id in var.instance_ids : can(regex("^i-[0-9a-f]{8,17}$", id))])
    error_message = "every entry must look like an EC2 instance ID (i-0123456789abcdef0)."
  }
}

# --- the admin-configurable schedule -----------------------------------------
#
# Defaults are stated EXPLICITLY rather than left implicit: weekdays, 08:00 on
# and 20:00 off, in America/New_York. Nothing here is derived from the caller's
# locale or from UTC-with-an-offset-in-a-comment — the timezone is a first-class
# input and EventBridge Scheduler applies it natively, including DST.

variable "start_cron" {
  description = <<-EOT
    When to START the instances, as an EventBridge Scheduler expression
    (6-field cron: minute hour day-of-month month day-of-week year, or
    rate(...)/at(...)). Evaluated in `timezone`.

    Default: cron(0 8 ? * MON-FRI *)  = 08:00 Mon-Fri.
    Set to null to create NO start schedule (stop-only mode: the box is a
    manual-start box that gets swept off every evening as a cost backstop).
  EOT
  type        = string
  default     = "cron(0 8 ? * MON-FRI *)"
  nullable    = true

  validation {
    condition     = var.start_cron == null || can(regex("^(cron|rate|at)\\(.+\\)$", coalesce(var.start_cron, "cron(x)")))
    error_message = "start_cron must be a cron(...), rate(...) or at(...) expression, or null."
  }
}

variable "stop_cron" {
  description = <<-EOT
    When to STOP the instances. Same grammar and timezone as start_cron.

    Default: cron(0 20 ? * MON-FRI *) = 20:00 Mon-Fri.
    Set to null to create NO stop schedule (start-only mode — rarely what you
    want, since the whole point of this module is the stop half).
  EOT
  type        = string
  default     = "cron(0 20 ? * MON-FRI *)"
  nullable    = true

  validation {
    condition     = var.stop_cron == null || can(regex("^(cron|rate|at)\\(.+\\)$", coalesce(var.stop_cron, "cron(x)")))
    error_message = "stop_cron must be a cron(...), rate(...) or at(...) expression, or null."
  }
}

variable "timezone" {
  description = <<-EOT
    IANA timezone the crons are evaluated in, e.g. America/New_York, Europe/London,
    Asia/Kolkata, UTC. EventBridge Scheduler resolves DST itself, so a
    business-hours window stays at the same LOCAL time year-round — which a
    UTC-only EventBridge *Rule* cannot do without editing the cron twice a year.
  EOT
  type        = string
  default     = "America/New_York"

  validation {
    condition     = length(trimspace(var.timezone)) > 0
    error_message = "timezone must be a non-empty IANA timezone name."
  }
}

variable "enabled" {
  description = <<-EOT
    Master switch. false leaves both schedules DEFINED but in state DISABLED —
    they stop firing, nothing is destroyed, and flipping back to true restores
    the exact same schedule. Use this rather than commenting the module out
    (which would delete the IAM role and both schedules).
  EOT
  type        = bool
  default     = true
}

# --- delivery tuning ----------------------------------------------------------

variable "retry_max_attempts" {
  description = "Retries EventBridge Scheduler makes if the EC2 API call fails."
  type        = number
  default     = 3
}

variable "retry_max_event_age_seconds" {
  description = <<-EOT
    How long a failed invocation may keep being retried. Deliberately SHORT
    (10 min) rather than the AWS default of 24h: a stop that finally succeeds
    fourteen hours late would power the box off in the middle of the next
    working day. If the window passes, the next scheduled fire handles it.
  EOT
  type        = number
  default     = 600

  validation {
    condition     = var.retry_max_event_age_seconds >= 60 && var.retry_max_event_age_seconds <= 86400
    error_message = "retry_max_event_age_seconds must be between 60 and 86400 (AWS limit)."
  }
}

variable "schedule_group_name" {
  description = "EventBridge Scheduler group to create the schedules in. 'default' always exists."
  type        = string
  default     = "default"
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}
