terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.55.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "2.8.1"
    }
  }

  backend "s3" {
    # Filled via `terraform init -backend-config=backend.hcl` (see backend.hcl.example).
  }
}
