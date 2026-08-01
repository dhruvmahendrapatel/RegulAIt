terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # aws_scheduler_schedule (EventBridge Scheduler) landed in 4.55.
      version = ">= 5.60"
    }
  }
}
