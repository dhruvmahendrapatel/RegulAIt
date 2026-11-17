terraform {
  # terraform-aws-modules/rds 7.x needs 1.11.1 or later.
  required_version = ">= 1.11.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.59"
    }
  }
}
