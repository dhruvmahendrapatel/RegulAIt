# github-oidc-role: the GitHub Actions OIDC identity provider in one AWS account,
# plus CI roles that trust it.
#
# Two kinds of role:
#   - the original branch roles (plan: pull_request; deploy: refs/heads/main).
#     Kept for compatibility; turn them off with create_branch_roles = false.
#   - environment roles (environment_roles): each trusts exactly one repository
#     AND one GitHub deployment environment (sub =
#     "repo:<owner>/<repo>:environment:<name>"). A job reaches such a role only
#     when it runs in that environment, so the environment's protection rules
#     (required reviewers, branch policy) gate every assumption. StringEquals,
#     never StringLike, so no wildcard ever widens the trust.
#
# Every role carries a permissions boundary. No long-lived key is created
# anywhere (ADR-0002, ADR-0004).

data "tls_certificate" "github" {
  count = var.create_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_oidc_provider ? 1 : 0
  provider        = aws.workload
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github[0].certificates[0].sha1_fingerprint]
  tags            = var.tags
}

locals {
  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_oidc_provider_arn
  repo_sub     = "repo:${var.github_org}/${var.github_repo}"
}

### Plan role — read-only, usable from PR workflows including forks ###

resource "aws_iam_role" "plan" {
  count                = var.create_branch_roles ? 1 : 0
  provider             = aws.workload
  name                 = "gh-actions-${var.project}-plan"
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "${local.repo_sub}:pull_request"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  count      = var.create_branch_roles ? 1 : 0
  provider   = aws.workload
  role       = aws_iam_role.plan[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

### Deploy role — write access, protected branch only ###

resource "aws_iam_role" "deploy" {
  count                = var.create_branch_roles ? 1 : 0
  provider             = aws.workload
  name                 = "gh-actions-${var.project}-deploy"
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "${local.repo_sub}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "deploy" {
  provider   = aws.workload
  for_each   = var.create_branch_roles ? toset(var.deploy_role_policy_arns) : toset([])
  role       = aws_iam_role.deploy[0].name
  policy_arn = each.value
}

### Environment roles — one repository + one GitHub environment, exact match ###

resource "aws_iam_role" "environment" {
  for_each             = var.environment_roles
  provider             = aws.workload
  name                 = each.value.role_name
  path                 = each.value.path
  description          = "GitHub Actions, ${var.github_repo}, environment ${each.value.environment} only."
  permissions_boundary = each.value.permissions_boundary_arn
  max_session_duration = each.value.max_session_duration_seconds
  tags                 = merge(var.tags, each.value.tags)

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubEnvironmentOnly"
      Effect    = "Allow"
      Principal = { Federated = local.provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${local.repo_sub}:environment:${each.value.environment}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "environment" {
  for_each = var.environment_roles
  provider = aws.workload
  name     = "${each.value.role_name}-permissions"
  role     = aws_iam_role.environment[each.key].name
  policy   = each.value.policy_json
}
