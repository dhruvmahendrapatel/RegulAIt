terraform {
  required_version = ">= 1.9"

  required_providers {
    gitlab = {
      source  = "gitlabhq/gitlab"
      version = ">= 18.0"
    }
  }
}
