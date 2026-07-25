variable "name" {
  description = "Name prefix for every resource this module creates."
  type        = string
}

variable "vpc_id" {
  description = "VPC to deploy into. Empty string means the account's default VPC."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type. The docker-compose build happens on-instance, so anything below 2 GB RAM needs swap_gb > 0."
  type        = string
  default     = "t3.small"
}

variable "app_port" {
  description = "TCP port the app listens on; opened to ingress_cidrs."
  type        = number
}

variable "ingress_cidrs" {
  description = "CIDRs allowed to reach app_port. Default is open — override for anything beyond throwaway dev stacks."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "source_bucket_name" {
  description = "Name of the S3 bucket this module creates for the source bundle."
  type        = string
}

variable "source_object_key" {
  description = "Object key of the source tarball the instance downloads on boot."
  type        = string
  default     = "source.tar.gz"
}

variable "swap_gb" {
  description = "Swapfile size in GB added before the build (0 disables)."
  type        = number
  default     = 4
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
