# scheduled-power — stop and start a fixed set of EC2 instances on a schedule,
# with NO always-on compute of its own.
#
# Mechanism: two EventBridge Scheduler schedules whose target is the "universal
# target" (AWS SDK target) `arn:aws:scheduler:::aws-sdk:ec2:stopInstances` /
# `...:startInstances`. Scheduler assumes the role below and makes the EC2 API
# call directly, so there is no Lambda, no deployment package, no log group, no
# runtime to patch, and no cold start. See README.md for the alternatives that
# were considered and rejected.
#
# Cost of the mechanism itself: effectively zero. EventBridge Scheduler's free
# tier is 14,000,000 invocations/month; a weekday on/off pair is ~44/month.
#
# SAFETY NOTE, because this module is pointed at stateful boxes: StopInstances
# is a graceful ACPI shutdown and preserves EBS. This module never calls
# TerminateInstances, and its IAM policy does not grant ec2:TerminateInstances —
# so even a compromised schedule definition cannot destroy the volume.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  instance_arns = [
    for id in var.instance_ids :
    "arn:${local.partition}:ec2:${local.region}:${local.account_id}:instance/${id}"
  ]

  state = var.enabled ? "ENABLED" : "DISABLED"

}

# --- the role EventBridge Scheduler assumes -----------------------------------

resource "aws_iam_role" "scheduler" {
  name        = "${var.name}-scheduler"
  description = "Assumed by EventBridge Scheduler to stop/start ${var.name} instances."
  tags        = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      # Confused-deputy guard: only THIS account's scheduler service may assume
      # the role. This is exactly the trust policy AWS documents for an
      # EventBridge Scheduler execution role.
      #
      # An aws:SourceArn condition narrowing this further to schedules named
      # "${var.name}-*" was tried and REMOVED, because it does not work: any
      # form of it — ArnLike, or ArnLikeIfExists, or a pattern as wide as
      # `schedule/<group>/*` — makes CreateSchedule fail with
      #
      #   ValidationException: The execution role you provide must allow AWS
      #   EventBridge Scheduler to assume the role.
      #
      # CreateSchedule validates the trust relationship up front, and that
      # validation does not satisfy an aws:SourceArn condition. Note the
      # failure reads exactly like IAM propagation lag and is not: it persists
      # indefinitely, across separate applies minutes apart. Verified by
      # bisecting the trust policy against live CreateSchedule calls —
      # SourceAccount-only passes, anything adding SourceArn fails.
      #
      # WHAT THIS GIVES UP, stated plainly: cross-account confused-deputy is
      # still blocked (SourceAccount must equal this account). What is lost is
      # INTRA-account narrowing — another schedule in this same account could
      # name this role. The compensating control is the permission policy
      # below: it grants exactly StartInstances/StopInstances on exactly the
      # instance ARNs passed in, so the worst such a schedule could do is stop
      # or start the boxes this module already manages. No Terminate, no
      # wildcard resource.
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
      }
    }]
  })
}

# Least privilege, stated exactly: two actions, and only on the instance ARNs
# the caller passed in. No wildcards on Resource, no ec2:* , no Terminate,
# no Reboot, no describe. EC2 Start/StopInstances both support instance-level
# resource permissions, so this is enforced by IAM rather than by convention.
resource "aws_iam_role_policy" "power" {
  name = "start-stop-listed-instances"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "StartStopOnlyTheseInstances"
      Effect   = "Allow"
      Action   = ["ec2:StartInstances", "ec2:StopInstances"]
      Resource = local.instance_arns
    }]
  })
}

# --- the schedules ------------------------------------------------------------

resource "aws_scheduler_schedule" "stop" {
  count = var.stop_cron == null ? 0 : 1

  name        = "${var.name}-stop"
  group_name  = var.schedule_group_name
  description = "Stop ${length(var.instance_ids)} instance(s): ${var.stop_cron} (${var.timezone})"
  state       = local.state

  schedule_expression          = var.stop_cron
  schedule_expression_timezone = var.timezone

  # OFF = fire at the stated minute. The alternative ("FLEXIBLE") lets AWS
  # smear the invocation across a window, which is fine for batch jobs and
  # actively confusing for "why did the dev box die at 20:11".
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:${local.partition}:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ InstanceIds = var.instance_ids })

    retry_policy {
      maximum_retry_attempts       = var.retry_max_attempts
      maximum_event_age_in_seconds = var.retry_max_event_age_seconds
    }
  }

  depends_on = [aws_iam_role_policy.power]
}

resource "aws_scheduler_schedule" "start" {
  count = var.start_cron == null ? 0 : 1

  name        = "${var.name}-start"
  group_name  = var.schedule_group_name
  description = "Start ${length(var.instance_ids)} instance(s): ${var.start_cron} (${var.timezone})"
  state       = local.state

  schedule_expression          = var.start_cron
  schedule_expression_timezone = var.timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:${local.partition}:scheduler:::aws-sdk:ec2:startInstances"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ InstanceIds = var.instance_ids })

    retry_policy {
      maximum_retry_attempts       = var.retry_max_attempts
      maximum_event_age_in_seconds = var.retry_max_event_age_seconds
    }
  }

  depends_on = [aws_iam_role_policy.power]
}
