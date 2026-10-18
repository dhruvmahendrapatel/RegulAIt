variable "gitlab_base_url" {
  type    = string
  default = "https://gitlab.com/api/v4/"
}

variable "gitlab_group_full_path" {
  description = "Full path of the demo group the owner created in the GitLab UI. Set in terraform.tfvars."
  type        = string
}

variable "create_group_access_token" {
  description = "Create the read-only group access token (gitlab.com: Premium or Ultimate group only)."
  type        = bool
  default     = true
}

variable "token_expires_at" {
  description = "Token expiry (YYYY-MM-DD), shortly after the demo."
  type        = string
  default     = "2026-11-15"
}
