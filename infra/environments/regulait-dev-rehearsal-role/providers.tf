# The owner applies this ONCE from their own machine with a short-lived
# Identity Center session for the regulait-dev workload account (ADR-0002,
# ADR-0004: no access key anywhere). allowed_account_ids makes Terraform refuse
# to run against any other account, whatever the profile resolves to.

provider "aws" {
  region              = var.aws_region
  profile             = var.workload_sso_profile
  allowed_account_ids = [var.workload_account_id]

  default_tags {
    tags = local.tags
  }
}

# github-oidc-role expects an aws.workload alias; it is the same account.
provider "aws" {
  alias               = "workload"
  region              = var.aws_region
  profile             = var.workload_sso_profile
  allowed_account_ids = [var.workload_account_id]

  default_tags {
    tags = local.tags
  }
}
