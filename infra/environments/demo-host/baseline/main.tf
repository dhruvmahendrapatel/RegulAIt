# demo-host / baseline: modules/aws-security-baseline for the company
# Organization, with the demo-host account as its workload account (ADR-0228,
# ADR-0002). It is the same module the deleted July Organization ran: an
# organization CloudTrail trail (KMS, log-file validation), GuardDuty and
# Security Hub (FSBP, optional CIS) organization-wide, AWS Config in both
# accounts with an aggregator, account-level S3 public access blocks, a monthly
# budget, and SCPs at the root (no leaving the Organization, no disabling the
# guardrails, a region allow-list).
#
# Its own state, so tearing the host down never removes the audit trail.
# One-time prerequisites (trusted access for the Organization's services) are
# in DEMO_RUNBOOK.md §8.2 d.

module "security_baseline" {
  source = "../../../modules/aws-security-baseline"
  providers = {
    aws.management = aws.management
    aws.workload   = aws.workload
  }

  management_account_id      = var.management_account_id
  workload_account_id        = var.host_account_id
  organization_id            = var.organization_id
  organization_root_id       = var.organization_root_id
  allowed_regions            = var.allowed_regions
  aws_region                 = var.aws_region
  monthly_budget_usd         = var.monthly_budget_usd
  budget_notification_emails = var.budget_notification_emails
  enable_cis_standard        = var.enable_cis_standard
}
