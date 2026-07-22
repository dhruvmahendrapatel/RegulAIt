terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }

  backend "s3" {
    # Filled via `terraform init -backend-config=backend.hcl` — see
    # backend.hcl.example and infra/bootstrap/bootstrap-backend.sh, which
    # prints the real bucket/table/key values after the one-time bootstrap.
  }
}
