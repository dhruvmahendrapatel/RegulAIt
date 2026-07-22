provider "aws" {
  alias   = "management"
  region  = var.aws_region
  profile = var.management_sso_profile
}

provider "aws" {
  alias   = "workload"
  region  = var.aws_region
  profile = var.workload_sso_profile
}
