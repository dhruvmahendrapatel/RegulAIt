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

  # Referenced by the trust policy's aws:SourceArn condition. Written as a
  # prefix wildcard rather than the concrete schedule ARNs on purpose: naming
  # the schedules would make the role depend on the schedules and the schedules
  # depend on the role, which is a cycle Terraform cannot resolve.
  schedule_arn_pattern = "arn:${local.partition}:scheduler:${local.region}:${local.account_id}:schedule/${var.schedule_group_name}/${var.name}-*"
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
      # Confused-deputy guards: only THIS account's scheduler service, and only
      # schedules whose name this module owns, may assume the role.
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = local.schedule_arn_pattern }
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
