# The company account, as the Organization's management account, through a short-lived Identity Center
# session (ADR-0004). No IAM user, no access key.
provider "aws" {
  region  = var.aws_region
  profile = var.management_sso_profile

  # Fail closed: refuse to plan or apply if the profile resolves to any account
  # other than the company (management) account named in terraform.tfvars.
  allowed_account_ids = [var.management_account_id]
}
