# Inside the demo-host account: the company account's short-lived Identity
# Center session assumes the role Organizations created there (ADR-0004; the
# demo-sandbox pattern). No IAM user, no access key anywhere.
provider "aws" {
  region  = var.aws_region
  profile = var.management_sso_profile

  assume_role {
    role_arn     = "arn:aws:iam::${var.host_account_id}:role/${var.host_access_role_name}"
    session_name = "demo-host-terraform"
  }

  allowed_account_ids = [var.host_account_id]

  default_tags {
    tags = local.tags
  }
}
