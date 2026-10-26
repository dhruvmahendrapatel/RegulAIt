# aws-sandbox-account: a member account in an existing AWS Organization, with
# a total (not monthly) cost budget, an alert at a percentage of it, and an
# automatic spend cap: at 100% of the budget AWS Budgets attaches a deny SCP to
# the account. Applied from the Organization's management account.
#
# Project-agnostic: every name, amount and address is a variable.
#
# What the spend cap does and does not do, stated plainly:
# - Budgets evaluates actual spend a few times a day, and billing data lags by
#   up to about a day, so the cap fires late, not at the exact cent.
# - It denies only the actions in var.spend_cap_denied_actions. The defaults
#   are the calls that generate per-request AI spend; idle resources (a trail
#   bucket, a log group) keep their small storage cost.
# - SCPs never apply to the management account, only to this member account.

data "aws_caller_identity" "management" {}

data "aws_organizations_organization" "this" {}

locals {
  parent_id = var.parent_id != null ? var.parent_id : data.aws_organizations_organization.this.roots[0].id
}

resource "aws_organizations_account" "this" {
  name      = var.account_name
  email     = var.account_email
  parent_id = local.parent_id

  # The role the management account uses to reach into the new account. It is
  # assumed from a short-lived Identity Center session; no IAM user or key.
  role_name                  = var.access_role_name
  iam_user_access_to_billing = "DENY"

  # Teardown closes the account (all resources in it stop billing). Closing is
  # subject to the Organizations close-account quota and the account stays
  # SUSPENDED for 90 days before AWS removes it.
  close_on_deletion = var.close_on_deletion

  tags = var.tags

  lifecycle {
    # role_name is only used at creation; AWS cannot read it back.
    ignore_changes = [role_name]
  }
}

resource "aws_budgets_budget" "this" {
  name         = "${var.account_name}-total"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"

  # ANNUALLY from the start date: one running total for the life of the
  # sandbox, rather than a monthly limit that resets mid-demo.
  time_unit         = "ANNUALLY"
  time_period_start = var.budget_period_start

  cost_filter {
    name   = "LinkedAccount"
    values = [aws_organizations_account.this.id]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.budget_alert_threshold_percent
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_notification_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_notification_emails
  }

  tags = var.tags
}

# --- automatic spend cap -------------------------------------------------------

resource "aws_organizations_policy" "spend_cap" {
  count       = var.enable_spend_cap ? 1 : 0
  name        = "${var.account_name}-spend-cap"
  description = "Attached by AWS Budgets when ${var.account_name} reaches 100% of its budget."
  type        = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DenyMeteredAiCallsOverBudget"
      Effect   = "Deny"
      Action   = var.spend_cap_denied_actions
      Resource = "*"
    }]
  })
  tags = var.tags
}

data "aws_iam_policy_document" "budget_action_trust" {
  count = var.enable_spend_cap ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.management.account_id]
    }
  }
}

data "aws_iam_policy_document" "budget_action" {
  count = var.enable_spend_cap ? 1 : 0
  statement {
    sid       = "AttachOnlyTheSpendCapToOnlyThisAccount"
    actions   = ["organizations:AttachPolicy", "organizations:DetachPolicy"]
    resources = [aws_organizations_policy.spend_cap[0].arn, aws_organizations_account.this.arn]
  }
}

resource "aws_iam_role" "budget_action" {
  count              = var.enable_spend_cap ? 1 : 0
  name               = "${var.account_name}-budget-action"
  assume_role_policy = data.aws_iam_policy_document.budget_action_trust[0].json
  tags               = var.tags
}

resource "aws_iam_role_policy" "budget_action" {
  count  = var.enable_spend_cap ? 1 : 0
  name   = "attach-spend-cap"
  role   = aws_iam_role.budget_action[0].id
  policy = data.aws_iam_policy_document.budget_action[0].json
}

resource "aws_budgets_budget_action" "spend_cap" {
  count              = var.enable_spend_cap ? 1 : 0
  budget_name        = aws_budgets_budget.this.name
  action_type        = "APPLY_SCP_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_action[0].arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    scp_action_definition {
      policy_id  = aws_organizations_policy.spend_cap[0].id
      target_ids = [aws_organizations_account.this.id]
    }
  }

  dynamic "subscriber" {
    for_each = toset(var.budget_notification_emails)
    content {
      address           = subscriber.value
      subscription_type = "EMAIL"
    }
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy.budget_action]
}

# --- guardrails ------------------------------------------------------------------
#
# Attached to this account only, from creation. An Organization with no baseline
# SCPs would otherwise leave the sandbox free to run in any region, leave the
# Organization (escaping the spend cap) or stop its own audit trail.

resource "aws_organizations_policy" "guardrails" {
  count       = var.enable_guardrails ? 1 : 0
  name        = "${var.account_name}-guardrails"
  description = "Region allow-list, no leaving the Organization, no stopping or deleting CloudTrail trails in ${var.account_name}."
  type        = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyOutsideAllowedRegions"
        Effect = "Deny"
        # Global services are served from us-east-1 whatever region is asked for.
        NotAction = [
          "iam:*", "organizations:*", "sts:*", "support:*", "budgets:*", "ce:*",
          "account:*", "route53:*", "cloudfront:*", "waf:*", "wafv2:*", "health:*",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = var.allowed_regions } }
      },
      {
        Sid      = "DenyLeavingTheOrganization"
        Effect   = "Deny"
        Action   = ["organizations:LeaveOrganization"]
        Resource = "*"
      },
      {
        Sid      = "DenyDisablingTheTrail"
        Effect   = "Deny"
        Action   = ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail"]
        Resource = "*"
      },
    ]
  })
  tags = var.tags
}

resource "aws_organizations_policy_attachment" "guardrails" {
  count     = var.enable_guardrails ? 1 : 0
  policy_id = aws_organizations_policy.guardrails[0].id
  target_id = aws_organizations_account.this.id
}
