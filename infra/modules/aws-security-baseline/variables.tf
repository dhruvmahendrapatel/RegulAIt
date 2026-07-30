variable "project" {
  description = "Short project name, used as a resource-name prefix. Keeps this module reusable across future projects."
  type        = string
  default     = "regulait"
}

variable "management_account_id" {
  description = "AWS account ID of the Organizations Management account."
  type        = string
}

variable "workload_account_id" {
  description = "AWS account ID of the Workload member account."
  type        = string
}

variable "organization_id" {
  description = "AWS Organizations ID (e.g. o-xxxxxxxxxx), used to scope the CloudTrail bucket policy and SCPs."
  type        = string
}

variable "organization_root_id" {
  description = "AWS Organizations root ID (r-xxxx), the target for the baseline SCPs."
  type        = string
}

variable "aws_region" {
  description = "Region the Config aggregate authorization is scoped to."
  type        = string
  default     = "us-east-1"
}

variable "allowed_regions" {
  description = "Regions permitted by the region-allowlist SCP. Keep short to shrink both attack surface and accidental cross-region spend."
  type        = list(string)
  default     = ["us-east-1", "us-east-2"]
}

variable "monthly_budget_usd" {
  description = "Monthly AWS spend cap for the Budgets alert stack. OQ-002 in project-state/STATE.md — confirm with the user before applying."
  type        = number
  default     = 100
}

variable "budget_notification_emails" {
  description = "Email addresses notified at each budget threshold."
  type        = list(string)
}

variable "enable_cis_standard" {
  description = "Keep the CIS AWS Foundations Benchmark v1.2.0 Security Hub subscription enabled (AWS auto-enabled it alongside FSBP). Set false to unsubscribe it once its findings become noise — requires the one-time terraform import documented next to the resource in main.tf before the first apply of this toggle."
  type        = bool
  default     = true
}
