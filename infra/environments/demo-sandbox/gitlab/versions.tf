terraform {
  required_version = ">= 1.9"

  required_providers {
    gitlab = {
      source  = "gitlabhq/gitlab"
      version = "19.4.0"
    }
  }

  backend "s3" {
    # Filled via `terraform init -backend-config=backend.hcl` (see backend.hcl.example).
    # This state holds the scanner token in clear text: it stays in the
    # private, encrypted state bucket and is never copied anywhere else.
  }
}
