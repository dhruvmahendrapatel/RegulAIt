terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.55.0"
    }
  }

  backend "s3" {
    # Filled via `terraform init -backend-config=backend.hcl` (see backend.hcl.example):
    # the state bucket infra/bootstrap creates in the company account, its own key.
  }
}
