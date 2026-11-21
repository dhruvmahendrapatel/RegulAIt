terraform {
  required_version = ">= 1.11.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 9.0"
    }
  }
}
