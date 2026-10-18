variable "issuer_url" {
  description = "The external OIDC issuer (exactly the token's `iss`), https only, no trailing slash."
  type        = string
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~-]+)*$", var.issuer_url))
    error_message = "issuer_url must be an https URL with no query, fragment or trailing slash."
  }
}

variable "audience" {
  description = "The token audience (`aud`) the role accepts; also the provider's client id."
  type        = string
  default     = "sts.amazonaws.com"
}

variable "subjects" {
  description = "Exact token subjects (`sub`) the role accepts."
  type        = list(string)
  validation {
    condition     = length(var.subjects) >= 1 && alltrue([for s in var.subjects : length(trimspace(s)) > 0 && !strcontains(s, "*") && !strcontains(s, "?")])
    error_message = "Give at least one subject, with no wildcard characters."
  }
}

variable "existing_provider_arn" {
  description = "Use an OIDC provider that already exists in the account for this issuer instead of creating one."
  type        = string
  default     = null
}

variable "role_name" {
  type = string
}

variable "role_description" {
  type    = string
  default = "Assumed by an external OIDC workload through web identity federation."
}

variable "policy_json" {
  description = "The role's inline permissions policy (JSON)."
  type        = string
}

variable "max_session_duration" {
  description = "Longest session the role allows, in seconds."
  type        = number
  default     = 3600
}

variable "tags" {
  type    = map(string)
  default = {}
}
