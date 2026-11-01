variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "management_sso_profile" {
  description = "AWS CLI Identity Center profile for the company (management) account."
  type        = string
}

variable "management_account_id" {
  description = "The company account's id. terraform.tfvars only."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.management_account_id))
    error_message = "management_account_id must be 12 digits."
  }
}

variable "host_account_id" {
  description = "The demo-host account id (output host_account_id of ../account). terraform.tfvars only."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.host_account_id))
    error_message = "host_account_id must be 12 digits."
  }
}

variable "host_access_role_name" {
  type    = string
  default = "OrganizationAccountAccessRole"
}

variable "organization_id" {
  description = "o-xxxxxxxxxx, from `aws organizations describe-organization`."
  type        = string
}

variable "organization_root_id" {
  description = "r-xxxx, from `aws organizations list-roots`."
  type        = string
}

variable "allowed_regions" {
  description = "Region allow-list SCP at the Organization root. Must include every region the sandbox and host stacks use."
  type        = list(string)
  default     = ["us-east-1", "us-east-2"]
}

variable "monthly_budget_usd" {
  description = "Organization-wide monthly budget alert."
  type        = number
  default     = 100
}

variable "budget_notification_emails" {
  type = list(string)
}

variable "enable_cis_standard" {
  description = "Security Hub CIS v1.2.0 subscription in both accounts."
  type        = bool
  default     = true
}
