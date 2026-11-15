### Identity of the install ###

variable "name_prefix" {
  description = "Prefix of every name this stack creates. If your installer role uses infra/modules/aws-byoc-deployer-policy, use the same prefix."
  type        = string
  default     = "regulait"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,22}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix: 4-24 lowercase letters, digits and '-', starting with a letter."
  }
}

variable "tags" {
  description = "Tags on every resource (pass the same map as the provider's default_tags)."
  type        = map(string)
  default     = {}
}

### Network ###

variable "vpc_cidr" {
  description = "CIDR of the new VPC. Pick one that does not overlap networks you will peer with."
  type        = string
  default     = "10.60.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be an IPv4 CIDR of /20 or larger."
  }
}

variable "az_count" {
  description = "Availability zones to spread over (RDS needs at least 2)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "egress_mode" {
  description = <<-EOT
    How workloads reach the internet.
      "allow_list" (default): only the hostnames in egress_allowed_domains, over
                   TLS (SNI) on 443, through AWS Network Firewall; everything else
                   is dropped and logged. AWS services are reached through VPC
                   endpoints and never cross the firewall.
      "none":      no internet path at all (no internet gateway, no NAT). AWS
                   services through VPC endpoints only. SSO to a cloud identity
                   provider and SaaS connectors cannot work in this mode.
  EOT
  type        = string
  default     = "allow_list"

  validation {
    condition     = contains(["allow_list", "none"], var.egress_mode)
    error_message = "egress_mode must be \"allow_list\" or \"none\"."
  }
}

variable "egress_allowed_domains" {
  description = <<-EOT
    Hostnames workloads may reach on 443 when egress_mode = "allow_list". A
    leading dot allows subdomains (".atlassian.net"). The default is Microsoft
    Entra ID sign-in only; add your PM tool, Git host and any model vendor
    outside Bedrock. Every addition is a disclosed data path (DATA_BOUNDARY.md).
  EOT
  type        = list(string)
  default     = ["login.microsoftonline.com"]

  validation {
    condition     = alltrue([for d in var.egress_allowed_domains : can(regex("^\\.?([a-z0-9-]+\\.)+[a-z]{2,}$", d))])
    error_message = "Each entry must be a lowercase hostname, optionally with a leading dot. No wildcards, IPs or ports."
  }
}

variable "log_retention_days" {
  description = "Retention of the stack's CloudWatch log groups (flow logs, firewall, EKS control plane)."
  type        = number
  default     = 365
}

### Kubernetes ###

variable "kubernetes_version" {
  description = "EKS Kubernetes version."
  type        = string
  default     = "1.34"
}

variable "cluster_endpoint_public_access_cidrs" {
  description = <<-EOT
    Public CIDRs allowed to reach the Kubernetes API. Empty (default) = private
    endpoint only, reachable from inside the VPC (a bastion, VPN or Direct
    Connect). 0.0.0.0/0 is refused.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.cluster_endpoint_public_access_cidrs : can(cidrhost(c, 0)) && c != "0.0.0.0/0"])
    error_message = "Each entry must be a CIDR, and 0.0.0.0/0 is refused."
  }
}

variable "cluster_admin_principal_arns" {
  description = "IAM role or user ARNs (your installers, SSO admin roles) given cluster-admin through EKS access entries. The principal running Terraform is added automatically."
  type        = list(string)
  default     = []
}

variable "node_instance_types" {
  type    = list(string)
  default = ["m7i.large"]
}

variable "node_count" {
  description = "Nodes in the managed node group (min = desired; max is one more)."
  type        = number
  default     = 2
}

variable "gateway_namespace" {
  description = "Namespace the Helm chart is installed into."
  type        = string
  default     = "regulait"
}

variable "gateway_service_account" {
  description = "Service account (and Service) name of the gateway: the chart names both <release>-gateway."
  type        = string
  default     = "regulait-gateway"
}

### Database ###

variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "db_engine_version" {
  description = "PostgreSQL major version (the product targets 16)."
  type        = string
  default     = "16"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type    = number
  default = 14

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be 1-35 (0 would turn automated backups off)."
  }
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database. Turn off only for a disposable rehearsal."
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "Delete without a final snapshot. Only for a disposable rehearsal."
  type        = bool
  default     = false
}

### Audit anchors ###

variable "audit_object_lock_mode" {
  description = "COMPLIANCE (default): no one, including the account root, can delete an anchor before its retention ends. GOVERNANCE is for rehearsals only."
  type        = string
  default     = "COMPLIANCE"
}

variable "audit_retention_days" {
  description = "Days each anchor stays locked. Match or exceed the audit-log retention your compliance classification requires."
  type        = number
  default     = 2555
}

### Models ###

variable "bedrock_model_ids" {
  description = <<-EOT
    Bedrock model IDs or inference-profile IDs the gateway may invoke, e.g.
    "anthropic.claude-sonnet-4-5-20250929-v1:0" or a cross-region profile
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0". Enable access to them in
    the Bedrock console first (the preflight checks). Empty = no Bedrock access.
  EOT
  type        = list(string)
  default     = []
}

### Container images ###

variable "ecr_pull_through_ecr_public" {
  description = "Create a pull-through cache for public.ecr.aws, so nodes can pull public images (used by the smoke test) without internet egress."
  type        = bool
  default     = true
}

### IAM ###

variable "iam_permissions_boundary_arn" {
  description = "Permissions boundary for every IAM role this stack creates. Required when the installer role is limited by infra/modules/aws-byoc-deployer-policy (pass its workload_boundary_policy_arn)."
  type        = string
  default     = null
}

### Ingress ###

variable "ingress_controller" {
  description = "Create the AWS Load Balancer Controller's identity (Pod Identity role with the upstream v3.6.3 policy) and the ELB VPC endpoint, so an internal ALB can front the gateway with your ACM certificate. Needed for SSO (users must reach the gateway over HTTPS)."
  type        = bool
  default     = true
}

variable "ingress_allowed_cidrs" {
  description = "Networks allowed to reach the internal ALB (your corporate ranges over VPN or Direct Connect). Empty = the VPC only."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.ingress_allowed_cidrs : can(cidrhost(c, 0)) && c != "0.0.0.0/0"])
    error_message = "Each entry must be a CIDR, and 0.0.0.0/0 is refused (the ALB is internal)."
  }
}

variable "ingress_hostname" {
  description = "Hostname users reach RegulAIt at (REGULAIT_PUBLIC_URL host). Used in the Ingress manifest output."
  type        = string
  default     = null
}

variable "ingress_certificate_arn" {
  description = "ACM certificate ARN for ingress_hostname, in this region."
  type        = string
  default     = null
}
