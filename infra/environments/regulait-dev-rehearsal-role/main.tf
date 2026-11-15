# regulait-dev rehearsal role (ADR-0325, PR 1 of lane E10).
#
# One IAM role in regulait-dev that GitHub Actions can assume ONLY from a job
# running in this repository's `rehearsal` environment (which has required
# reviewers). It can build and destroy the BYOC stack (infra/modules/byoc-aws)
# and nothing else: its boundary and policy come from aws-byoc-deployer-policy.
# IAM, RDS, Secrets Manager, Logs, EKS, Network Firewall, S3 and ECR are limited
# to resources named "regulait-rehearsal-*", KMS keys and EC2 structure to
# resources tagged purpose=rehearsal, and every create must carry that tag.
# Roles it creates carry the workload boundary (no IAM writes, no federated
# sessions). Anything tagged as production is denied.
#
# Non-production only. Never point this at another account.

locals {
  name_prefix = "regulait-rehearsal"
  role_name   = "gh-actions-regulait-rehearsal"
  role_arn    = "arn:aws:iam::${var.workload_account_id}:role/${local.role_name}"

  tags = {
    project    = "regulait"
    purpose    = "rehearsal"
    managed-by = "terraform"
    adr        = "0325"
  }
}

module "deployer_policy" {
  source = "../../modules/aws-byoc-deployer-policy"

  name_prefix         = local.name_prefix
  allowed_regions     = [var.aws_region]
  scope_tag           = { key = "purpose", value = "rehearsal" }
  protected_role_arns = [local.role_arn]
  tags                = local.tags
}

module "github_oidc" {
  source = "../../modules/github-oidc-role"
  providers = {
    aws.workload = aws.workload
  }

  github_org                 = var.github_org
  github_repo                = var.github_repo
  create_oidc_provider       = var.create_oidc_provider
  existing_oidc_provider_arn = var.existing_oidc_provider_arn
  create_branch_roles        = false
  github_repository_id       = var.github_repository_id
  tags                       = local.tags

  environment_roles = {
    rehearsal = {
      role_name                    = local.role_name
      environment                  = var.github_environment
      permissions_boundary_arn     = module.deployer_policy.boundary_policy_arn
      policy_json                  = module.deployer_policy.deployer_policy_json
      max_session_duration_seconds = var.max_session_duration_seconds
    }
  }
}
