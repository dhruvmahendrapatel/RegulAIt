terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60"
    }
  }

  backend "s3" {
    # Filled via `terraform init -backend-config=backend.hcl` — same backend as
    # infra/environments/regulait-dev, different state key (see backend.hcl.example).
  }
}
