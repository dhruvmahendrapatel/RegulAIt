# Inside the sandbox account: the management account's short-lived Identity
# Center session assumes the role Organizations created in the new account
# (ADR-0004: no IAM user, no access key anywhere).
provider "aws" {
  region  = var.aws_region
  profile = var.management_sso_profile

  assume_role {
    role_arn     = "arn:aws:iam::${var.sandbox_account_id}:role/${var.sandbox_access_role_name}"
    session_name = "demo-sandbox-terraform"
  }

  # Refuse to touch any other account, whatever the profile resolves to.
  allowed_account_ids = [var.sandbox_account_id]

  default_tags {
    tags = local.tags
  }
}
