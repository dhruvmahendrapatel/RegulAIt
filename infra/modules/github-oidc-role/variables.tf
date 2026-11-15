variable "project" {
  type    = string
  default = "regulait"
}

variable "github_org" {
  description = "GitHub owner (org or user) of the repository."
  type        = string
}

variable "github_repo" {
  description = "Repository name only, without the owner."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}

variable "create_oidc_provider" {
  description = "Create the account's GitHub OIDC identity provider. An account holds at most one per issuer URL, so set false and pass existing_oidc_provider_arn when it already exists."
  type        = bool
  default     = true
}

variable "existing_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider in the account. Required when create_oidc_provider is false."
  type        = string
  default     = null

  validation {
    condition     = var.existing_oidc_provider_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.existing_oidc_provider_arn))
    error_message = "existing_oidc_provider_arn must be the ARN of the token.actions.githubusercontent.com provider."
  }

  validation {
    condition     = var.create_oidc_provider || var.existing_oidc_provider_arn != null
    error_message = "Pass existing_oidc_provider_arn when create_oidc_provider is false."
  }
}

variable "create_branch_roles" {
  description = "Create the original plan (pull_request, reachable from forks) and deploy (refs/heads/main) roles. Off by default (ADR-0180); turn on only with a reason."
  type        = bool
  default     = false
}

variable "permissions_boundary_arn" {
  description = "Boundary for the branch roles (the aws-security-baseline Deploy-Builder boundary). Required when create_branch_roles is true."
  type        = string
  default     = null

  validation {
    condition     = !var.create_branch_roles || var.permissions_boundary_arn != null
    error_message = "permissions_boundary_arn is required when create_branch_roles is true."
  }
}

variable "deploy_role_policy_arns" {
  description = "Managed policy ARNs granting write access for the deploy role."
  type        = list(string)
  default     = []
}

variable "github_repository_id" {
  description = <<-EOT
    Numeric GitHub repository ID. When set, environment roles trust the subject
    "repository_id:<id>:environment:<name>" instead of
    "repo:<owner>/<repo>:environment:<name>", so a renamed, transferred or
    re-created repository with the same name cannot inherit the trust. The
    repository's OIDC subject template must then be customised to
    ["repository_id", "environment"] (docs/ops/BYOC_REHEARSAL_ROLE.md).
  EOT
  type        = number
  default     = null
}

variable "environment_roles" {
  description = <<-EOT
    Roles that trust exactly one GitHub deployment environment of this
    repository (sub = repo:<owner>/<repo>:environment:<environment>).
    Each needs a permissions boundary and an inline permission policy; the
    effective permissions are their intersection.
  EOT
  type = map(object({
    role_name                    = string
    environment                  = string
    permissions_boundary_arn     = string
    policy_json                  = string
    path                         = optional(string, "/")
    max_session_duration_seconds = optional(number, 3600)
    tags                         = optional(map(string), {})
  }))
  default = {}

  validation {
    condition     = alltrue([for r in values(var.environment_roles) : can(regex("^[A-Za-z0-9_.-]+$", r.environment))])
    error_message = "environment must be a plain GitHub environment name (letters, digits, '_', '.', '-'): no wildcard."
  }

  validation {
    condition     = alltrue([for r in values(var.environment_roles) : r.max_session_duration_seconds >= 3600 && r.max_session_duration_seconds <= 43200])
    error_message = "max_session_duration_seconds must be between 3600 and 43200."
  }
}
