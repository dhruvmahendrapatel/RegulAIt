variable "aws_region" {
  description = "Region of every resource here; must be in allowed_regions of ../account (the sandbox guardrail SCP)."
  type        = string
  default     = "us-east-1"
}

variable "management_sso_profile" {
  description = "AWS CLI Identity Center profile for the company (management) account; it assumes into the sandbox."
  type        = string
}

variable "sandbox_account_id" {
  description = "Output sandbox_account_id of ../account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.sandbox_account_id))
    error_message = "sandbox_account_id must be 12 digits."
  }
}

variable "sandbox_access_role_name" {
  type    = string
  default = "OrganizationAccountAccessRole"
}

variable "regulait_federation_issuer_url" {
  description = "RegulAIt's federation issuer: REGULAIT_PUBLIC_URL of the demo instance plus /federation (shown on the Cloud federation card). For the laptop behind the Cloudflare Tunnel that is https://regulait.<domain>/federation."
  type        = string
  validation {
    condition     = startswith(var.regulait_federation_issuer_url, "https://") && endswith(var.regulait_federation_issuer_url, "/federation")
    error_message = "regulait_federation_issuer_url must be https://<host>/federation (REGULAIT_PUBLIC_URL plus /federation); plain http is refused."
  }
  validation {
    # IAM fetches the issuer over the public internet, and the trust policy is
    # keyed on the exact host: a loopback, an IP literal or a rotating
    # trycloudflare.com quick-tunnel name would never verify, or would break.
    condition     = !can(regex("^https://(localhost|127\\.|\\[|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+[:/])|\\.trycloudflare\\.com[:/]", var.regulait_federation_issuer_url))
    error_message = "regulait_federation_issuer_url must use a stable public DNS name (a named Cloudflare Tunnel hostname), not localhost, an IP address or a trycloudflare.com quick tunnel."
  }
}

variable "aws_discovery_source_id" {
  description = "Id of the cloud_aws discovery source created in RegulAIt; the role trusts only regulait:discovery-source:<id>."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.aws_discovery_source_id))
    error_message = "aws_discovery_source_id must be the source's UUID."
  }
}

variable "bedrock_model_id" {
  description = "On-demand Bedrock foundation model id the generators call. Pick the lowest-priced text model enabled for the account in this region. Set in terraform.tfvars."
  type        = string
  validation {
    condition     = var.allow_cross_region_inference || !can(regex("^(us|us-gov|eu|apac|jp|au|ca|global)\\.", var.bedrock_model_id))
    error_message = "bedrock_model_id looks like a cross-region inference profile id. Pick a model invocable on demand in aws_region, or set allow_cross_region_inference = true after checking the region allow-list SCP (runbook step 4)."
  }
}

variable "allow_cross_region_inference" {
  description = "false (strict) keeps every Bedrock call in aws_region, inside the region allow-list SCP. true permits an inference-profile model id plus bedrock_extra_invoke_arns, and only works if the SCP allows every region the profile routes to."
  type        = bool
  default     = false
}

variable "bedrock_allowed_regions" {
  description = "Regions the sandbox guardrail SCP allows (allowed_regions in ../account; keep the two equal). Every ARN in bedrock_extra_invoke_arns must name one of them (or none, for a global ARN)."
  type        = list(string)
  default     = ["us-east-1", "us-east-2"]
}

variable "bedrock_extra_invoke_arns" {
  description = "Inference-profile and regional model ARNs the generators may also invoke. Only with allow_cross_region_inference = true."
  type        = list(string)
  default     = []
  validation {
    condition     = var.allow_cross_region_inference || length(var.bedrock_extra_invoke_arns) == 0
    error_message = "bedrock_extra_invoke_arns needs allow_cross_region_inference = true."
  }
  validation {
    condition = alltrue([
      for arn in var.bedrock_extra_invoke_arns :
      can(regex("^arn:[^:]+:bedrock:[^:]*:", arn)) && (split(":", arn)[3] == "" || contains(var.bedrock_allowed_regions, split(":", arn)[3]))
    ])
    error_message = "Every bedrock_extra_invoke_arns entry must be a Bedrock ARN in one of bedrock_allowed_regions; the region allow-list SCP denies calls routed anywhere else."
  }
}

variable "generator_reserved_concurrency" {
  description = "Reserved concurrency of each generator Lambda (1: runs never overlap). Set -1 only if the account's Lambda concurrency quota is too low to reserve any (runbook step 4)."
  type        = number
  default     = 1
}

variable "demo_company_slug" {
  description = "Fictional demo-company prefix for resource names (ADR-0197 decision 8)."
  type        = string
  default     = "larkfield"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.demo_company_slug))
    error_message = "demo_company_slug must be 3-21 lowercase letters, digits or hyphens."
  }
}

variable "schedule_timezone" {
  type    = string
  default = "America/New_York"
}

variable "activity_end_date" {
  description = "After this instant the generators never run again (RFC 3339, UTC)."
  type        = string
  default     = "2026-11-30T23:59:59Z"
}

variable "activity_enabled" {
  description = "false pauses both generators without destroying anything."
  type        = bool
  default     = true
}

variable "teardown_after" {
  type    = string
  default = "2026-11-30"
}
