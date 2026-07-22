module "security_baseline" {
  source = "../../modules/aws-security-baseline"
  providers = {
    aws.management = aws.management
    aws.workload   = aws.workload
  }

  management_account_id      = var.management_account_id
  workload_account_id        = var.workload_account_id
  organization_id            = var.organization_id
  organization_root_id       = var.organization_root_id
  allowed_regions            = var.allowed_regions
  monthly_budget_usd         = var.monthly_budget_usd
  budget_notification_emails = var.budget_notification_emails
}

module "identity_center" {
  source = "../../modules/identity-center-permission-sets"
  providers = {
    aws.management = aws.management
  }

  workload_account_id                 = var.workload_account_id
  management_account_id               = var.management_account_id
  user_principal_id                   = var.user_principal_id
  deploy_builder_boundary_policy_arn  = module.security_baseline.deploy_builder_boundary_policy_arn
  deploy_builder_boundary_policy_name = module.security_baseline.deploy_builder_boundary_policy_name
}

# Authored, not instantiated: no workload exists yet to deploy, and this
# module needs real deploy_role_policy_arns before it's useful. Uncomment
# and fill in once the first GitHub Actions pipeline is being wired up.
#
# module "github_oidc" {
#   source = "../../modules/github-oidc-role"
#   providers = {
#     aws.workload = aws.workload
#   }
#
#   github_org               = var.github_org
#   github_repo               = var.github_repo
#   permissions_boundary_arn = module.security_baseline.deploy_builder_boundary_policy_arn
#   deploy_role_policy_arns  = []
# }
