# demo-host / account: the member account the demo host runs in (ADR-0228).
# Workloads never run in the management account (ADR-0002), so the host gets
# its own account, created with the same module as the demo sandbox: a budget
# alert, the spend-cap SCP (it denies only model and function invocations, so
# it cannot stop the host) and the guardrail SCP (region allow-list, no leaving
# the Organization, no stopping CloudTrail). Non-production: the module refuses
# a prod/production tag.

locals {
  tags = {
    Project     = "RegulAIt"
    Environment = "demo"
    Purpose     = "demo-host"
    ManagedBy   = "terraform"
    Stack       = "demo-host-account"
    Teardown    = var.teardown_after
  }
}

module "host_account" {
  source = "../../../modules/aws-sandbox-account"

  account_name  = var.account_name
  account_email = var.account_email
  parent_id     = var.parent_id

  budget_limit_usd               = var.budget_limit_usd
  budget_period_start            = var.budget_period_start
  budget_alert_threshold_percent = 80
  budget_notification_emails     = var.budget_notification_emails
  enable_spend_cap               = true

  enable_guardrails = true
  allowed_regions   = var.allowed_regions

  tags = local.tags
}
