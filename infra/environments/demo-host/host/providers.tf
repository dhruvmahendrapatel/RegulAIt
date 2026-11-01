# Inside the demo-host account, as the deployer's own Identity Center session
# (`RegulAItDemoDeployer`, assigned in this account only; DEMO_RUNBOOK.md §8.4
# step 3). No role assumption, no management-account access, no IAM user, no
# access key (ADR-0004, ADR-0228).
#
# Teardown (§8.11) is break-glass: it runs this same stack with
# host_sso_profile set to a profile that reaches this account through the
# break-glass permission set, because the deployer may not delete evidence.
provider "aws" {
  region  = var.aws_region
  profile = var.host_sso_profile

  allowed_account_ids = [var.host_account_id]

  default_tags {
    tags = local.tags
  }
}
