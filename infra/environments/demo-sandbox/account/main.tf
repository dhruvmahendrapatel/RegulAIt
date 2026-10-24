# demo-sandbox / account: the third AWS account (ADR-0197 decision 2, amending
# ADR-0002 and ADR-0004). It holds only planted demo AI resources. It is
# non-production: no prod/production tag, account or role.
#
# Apply order and the full runbook: internal/product/DEMO_REAL_ACCOUNTS.md.
# The workload inside the account is a separate stack (../aws), because a
# provider cannot be configured from an account id this stack has not created yet.

locals {
  tags = {
    Project     = "RegulAIt"
    Environment = "sandbox"
    Purpose     = "demo"
    ManagedBy   = "terraform"
    Stack       = "demo-sandbox-account"
    Teardown    = var.teardown_after
  }
}

module "sandbox_account" {
  source = "../../../modules/aws-sandbox-account"

  account_name  = var.account_name
  account_email = var.account_email
  parent_id     = var.parent_id

  budget_limit_usd               = var.budget_limit_usd
  budget_period_start            = var.budget_period_start
  budget_alert_threshold_percent = 80
  budget_notification_emails     = var.budget_notification_emails
  enable_spend_cap               = true

  tags = local.tags
}
