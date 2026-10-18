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
    # the same state bucket as infra/environments/regulait-dev, its own key.
  }
}
