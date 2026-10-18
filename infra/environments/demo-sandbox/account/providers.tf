# The Organization's management account, through a short-lived Identity Center
# session (ADR-0004). No IAM user, no access key.
provider "aws" {
  region  = var.aws_region
  profile = var.management_sso_profile
}
