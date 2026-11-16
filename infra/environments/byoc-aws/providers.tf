# Credentials come from your normal AWS sign-in (AWS_PROFILE / aws sso login).
# allowed_account_ids makes Terraform refuse any account but the one you name.

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = var.tags
  }
}
