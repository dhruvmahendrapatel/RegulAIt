terraform {
  required_version = ">= 1.11.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.59"
    }
  }

  # State is local by default (a single installer, one machine). To keep it in
  # your own S3 bucket instead, copy backend.tf.example to backend.tf first.
}
