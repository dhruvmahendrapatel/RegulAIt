# aws-bedrock-activity-generator: a small Lambda function, run on a schedule,
# that makes a few short Bedrock Converse calls under its own IAM role. It
# exists to plant real, attributable AI activity in an account (CloudTrail
# records each call as a `Converse` event with this role as the caller).
#
# Cost is bounded four ways:
# - the handler caps calls per run and output tokens per call in code;
# - nothing retries a run: the schedule and Lambda's own async retries are both
#   0, a queued event older than 60 s is dropped, and reserved concurrency (1 by
#   default) means runs never overlap;
# - the schedule has an end date, after which it never fires again;
# - the role may invoke only the one model named in var.model_id.
# Expected spend is calls x tokens x the model's price; see the environment
# that instantiates this module for the worked figure.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  region       = data.aws_region.current.region
  account_id   = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  log_group    = "/aws/lambda/${var.name}"
  model_arn    = "arn:${local.partition}:bedrock:${local.region}::foundation-model/${var.model_id}"
  invoke_arns  = concat([local.model_arn], var.extra_invoke_resource_arns)
  package_path = "${path.root}/.terraform/build/${var.name}.zip"
}

data "archive_file" "handler" {
  type        = "zip"
  source_file = "${path.module}/src/handler.py"
  output_path = local.package_path
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "InvokeOnlyTheConfiguredModel"
    actions   = ["bedrock:InvokeModel"]
    resources = local.invoke_arns
  }
  statement {
    sid       = "WriteOwnLogsOnly"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = var.name
  description        = var.role_description
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name}-invoke"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_lambda_function" "this" {
  function_name    = var.name
  description      = var.role_description
  role             = aws_iam_role.lambda.arn
  runtime          = var.runtime
  handler          = "handler.handler"
  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256
  timeout          = 30
  memory_size      = 128

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      MODEL_ID      = var.model_id
      PROMPTS       = jsonencode(var.prompts)
      MAX_TOKENS    = tostring(var.max_tokens)
      CALLS_PER_RUN = tostring(var.calls_per_run)
    }
  }

  tags = var.tags

  depends_on = [aws_cloudwatch_log_group.this, aws_iam_role_policy.lambda]
}

# Scheduler invokes asynchronously, and Lambda retries a failed async run twice
# by default; without this a throttled run could repeat 3 x calls_per_run calls.
resource "aws_lambda_function_event_invoke_config" "this" {
  function_name                = aws_lambda_function.this.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}

# --- schedule --------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.this.arn]
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-${var.name}"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "this" {
  name        = var.name
  description = "Planted demo activity for ${var.name}; stops for good at ${var.end_date}."
  state       = var.enabled ? "ENABLED" : "DISABLED"

  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone
  end_date                     = var.end_date

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.this.arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
