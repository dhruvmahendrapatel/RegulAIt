variable "project" {
  type    = string
  default = "regulait"
}

variable "github_org" {
  description = "GitHub org or user that owns the repo, e.g. \"dhruvmahendrapatel\"."
  type        = string
}

variable "github_repo" {
  description = "Repo name only, e.g. \"RegulAIt\"."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Same boundary policy used for Deploy-Builder (aws-security-baseline module output) — applied to both CI roles."
  type        = string
}

variable "deploy_role_policy_arns" {
  description = "Managed policy ARNs granting write access for the deploy role. Left empty until there's an actual workload to deploy — see STATE.md."
  type        = list(string)
  default     = []
}
