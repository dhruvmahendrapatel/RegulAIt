variable "trail_name" {
  type = string
}

variable "bucket_name" {
  description = "Globally unique name of the trail's log bucket."
  type        = string
}

variable "log_retention_days" {
  description = "Days a log object is kept before the bucket expires it."
  type        = number
  default     = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
