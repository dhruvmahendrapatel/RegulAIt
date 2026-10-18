variable "group_full_path" {
  description = "Full path of the existing group the projects are created in."
  type        = string
}

variable "fixtures_root" {
  description = "Local directory holding one fixture directory per project."
  type        = string
}

variable "projects" {
  description = "Projects to create, keyed by project path; fixture_dir is relative to fixtures_root."
  type = map(object({
    description = string
    fixture_dir = string
  }))
}

variable "create_group_access_token" {
  description = "Create a read-only group access token (GitLab.com: Premium or Ultimate group only)."
  type        = bool
  default     = true
}

variable "token_name" {
  type    = string
  default = "ai-discovery-read-only"
}

variable "token_expires_at" {
  description = "Token expiry date (YYYY-MM-DD). Keep it shortly after the token's last planned use."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.token_expires_at))
    error_message = "token_expires_at must be YYYY-MM-DD."
  }
}
