variable "aws_region" {
  description = "Region for the app stack. Must be inside the security baseline's region allowlist."
  type        = string
  default     = "us-east-1"
}

variable "workload_sso_profile" {
  description = "AWS CLI SSO profile targeting the regulait-dev workload account."
  type        = string
  default     = "regulait-admin"
}

variable "instance_type" {
  description = "Instance type for the dev app box."
  type        = string
  default     = "t3.small"
}

variable "ingress_cidrs" {
  description = "Who can reach the app port. Open by default — this is a throwaway demo stack with key-gated APIs and per-deploy random secrets."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
