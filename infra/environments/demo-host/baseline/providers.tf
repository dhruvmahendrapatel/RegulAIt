# Management: the company account's short-lived Identity Center session.
provider "aws" {
  alias   = "management"
  region  = var.aws_region
  profile = var.management_sso_profile

  allowed_account_ids = [var.management_account_id]
}

# Workload: the demo-host account, reached by assuming the role Organizations
# created in it, from the same session (ADR-0004; the demo-sandbox pattern).
provider "aws" {
  alias   = "workload"
  region  = var.aws_region
  profile = var.management_sso_profile

  assume_role {
    role_arn     = "arn:aws:iam::${var.host_account_id}:role/${var.host_access_role_name}"
    session_name = "demo-host-baseline-terraform"
  }

  allowed_account_ids = [var.host_account_id]
}
