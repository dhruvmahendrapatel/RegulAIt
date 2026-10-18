variable "display_name" {
  description = "App registration display name."
  type        = string
}

variable "owners" {
  description = "Object ids that own the app registration and service principal. Empty means the identity running the apply."
  type        = list(string)
  default     = []
}

variable "credential_name" {
  type    = string
  default = "external-oidc-workload"
}

variable "issuer_url" {
  description = "The external OIDC issuer (exactly the token's `iss`), https only."
  type        = string
  validation {
    condition     = startswith(var.issuer_url, "https://") && !endswith(var.issuer_url, "/")
    error_message = "issuer_url must be an https URL without a trailing slash."
  }
}

variable "subject" {
  description = "The one token subject (`sub`) Entra accepts for this app."
  type        = string
  validation {
    condition     = length(trimspace(var.subject)) > 0
    error_message = "subject must not be empty."
  }
}

variable "audiences" {
  description = "Accepted token audiences. Entra's recommended value is the default."
  type        = list(string)
  default     = ["api://AzureADTokenExchange"]
}

variable "reader_scopes" {
  description = "Azure resource ids (subscription, resource group or resource) given the built-in Reader role."
  type        = list(string)
}

variable "activity_log_scopes" {
  description = "Scopes (normally the subscription) given a custom role that only reads the activity log."
  type        = list(string)
  default     = []
}
