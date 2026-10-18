variable "name" {
  description = "Name of the function, its role and its schedule. The role name is what a CloudTrail reader sees as the caller."
  type        = string
}

variable "role_description" {
  type    = string
  default = "Planted demo AI activity (scheduled Bedrock calls)."
}

variable "model_id" {
  description = "Bedrock foundation model id the function calls (on-demand, in this region). The role may invoke only this model plus extra_invoke_resource_arns."
  type        = string
}

variable "extra_invoke_resource_arns" {
  description = "Further resources bedrock:InvokeModel is allowed on, e.g. an inference profile and the regional models behind it."
  type        = list(string)
  default     = []
}

variable "prompts" {
  description = "Short prompts; one is picked at random per call. Keep them free of personal data."
  type        = list(string)
  validation {
    condition     = length(var.prompts) >= 1 && length(jsonencode(var.prompts)) <= 2048
    error_message = "Give at least one prompt, at most 2 KB in total."
  }
}

variable "max_tokens" {
  description = "Output tokens per call (the handler also caps this at 128)."
  type        = number
  default     = 48
  validation {
    condition     = var.max_tokens >= 1 && var.max_tokens <= 128
    error_message = "max_tokens must be between 1 and 128."
  }
}

variable "calls_per_run" {
  description = "Calls per scheduled run (the handler also caps this at 3)."
  type        = number
  default     = 1
  validation {
    condition     = var.calls_per_run >= 1 && var.calls_per_run <= 3
    error_message = "calls_per_run must be between 1 and 3."
  }
}

variable "schedule_expression" {
  description = "EventBridge Scheduler expression, read in schedule_timezone."
  type        = string
}

variable "schedule_timezone" {
  type    = string
  default = "UTC"
}

variable "end_date" {
  description = "UTC instant (RFC 3339) after which the schedule never fires again."
  type        = string
  validation {
    condition     = can(formatdate("YYYY", var.end_date))
    error_message = "end_date must be an RFC 3339 timestamp, e.g. 2026-11-30T23:59:59Z."
  }
}

variable "enabled" {
  description = "false keeps everything but stops the schedule firing."
  type        = bool
  default     = true
}

variable "runtime" {
  type    = string
  default = "python3.12"
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}
