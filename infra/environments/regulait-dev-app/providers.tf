provider "aws" {
  region  = var.aws_region
  profile = var.workload_sso_profile
}
