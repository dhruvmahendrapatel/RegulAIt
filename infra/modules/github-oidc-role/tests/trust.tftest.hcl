# Offline plan-only tests for the environment-role trust policy.

mock_provider "aws" {
  alias = "workload"
}

mock_provider "tls" {}

variables {
  github_org                 = "example-owner"
  github_repo                = "example-repo"
  create_oidc_provider       = false
  existing_oidc_provider_arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
  create_branch_roles        = false
  environment_roles = {
    rehearsal = {
      role_name                = "gh-actions-example-rehearsal"
      environment              = "rehearsal"
      permissions_boundary_arn = "arn:aws:iam::111111111111:policy/example-boundary"
      policy_json              = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "environment_role_trusts_one_repo_and_one_environment_exactly" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.environment["rehearsal"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example-owner/example-repo:environment:rehearsal"
    error_message = "The trust must pin the repository and the environment."
  }

  assert {
    condition     = !can(jsondecode(aws_iam_role.environment["rehearsal"].assume_role_policy).Statement[0].Condition.StringLike)
    error_message = "Environment roles must not use StringLike."
  }

  assert {
    condition     = aws_iam_role.environment["rehearsal"].permissions_boundary == "arn:aws:iam::111111111111:policy/example-boundary"
    error_message = "Every environment role carries its boundary."
  }

  assert {
    condition     = length(aws_iam_role.plan) == 0 && length(aws_iam_role.deploy) == 0 && length(aws_iam_openid_connect_provider.github) == 0
    error_message = "Branch roles and the provider are skipped when turned off."
  }
}

run "wildcard_environment_is_refused" {
  command = plan

  variables {
    environment_roles = {
      bad = {
        role_name                = "gh-actions-example-bad"
        environment              = "*"
        permissions_boundary_arn = "arn:aws:iam::111111111111:policy/example-boundary"
        policy_json              = "{}"
      }
    }
  }

  expect_failures = [var.environment_roles]
}

run "missing_provider_arn_is_refused" {
  command = plan

  variables {
    existing_oidc_provider_arn = null
  }

  expect_failures = [var.existing_oidc_provider_arn]
}
