variable "name_prefix" {
  description = "Prefix of every name the BYOC stack creates (IAM roles, instance profiles, S3 buckets). The deployer may manage IAM roles and buckets with this prefix only."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix: 4-32 lowercase letters, digits and '-', starting with a letter."
  }
}

variable "allowed_regions" {
  description = "Regions the deployer and every role it creates may act in. Global services (IAM, STS) are exempt."
  type        = list(string)

  validation {
    condition     = length(var.allowed_regions) > 0
    error_message = "List at least one region."
  }
}

variable "scope_tag" {
  description = <<-EOT
    Tag that marks resources the deployer owns, e.g. { key = "purpose", value = "rehearsal" }.
    When set: every create in tagged_create_actions must carry it; KMS keys,
    EC2 structure (instances, volumes, snapshots, routes, subnets, VPCs,
    endpoints, gateways) and, for the deployer, security groups can be changed
    only when they carry it; and the tag cannot be added to an existing EC2
    resource. Resources with names (RDS, Secrets Manager, Logs, EKS, Network
    Firewall, S3, ECR, IAM) are limited by name_prefix whether or not this is
    set. null turns the tag checks off, for an account whose tags are governed
    elsewhere.
  EOT
  type = object({
    key   = string
    value = string
  })
  default = null
}

variable "forbidden_tag_patterns" {
  description = "Any action on a resource whose tag (keys below) matches one of these patterns is denied, for the deployer and every role it creates. Keeps a rehearsal or pilot role away from anything marked production."
  type        = list(string)
  default     = ["*prod*"]
}

variable "forbidden_tag_keys" {
  description = "Tag keys checked against forbidden_tag_patterns."
  type        = list(string)
  default     = ["environment", "env"]
}

variable "attachable_managed_policy_arns" {
  description = "AWS-managed policies the deployer may attach to the roles it creates (EKS cluster, node, add-on and RDS monitoring roles). Nothing else can be attached."
  type        = list(string)
  default = [
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController",
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
    "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole",
  ]
}

variable "protected_role_arns" {
  description = "Roles no one under the deployer boundary may modify, typically the deployer role itself. Both boundary policies are always protected."
  type        = list(string)
  default     = []
}

variable "tagged_create_actions" {
  description = "Creates the deployer may make only with the scope tag in the request (all of these support tag-on-create). Used when scope_tag is set."
  type        = list(string)
  default = [
    "ec2:CreateVpc", "ec2:CreateSubnet", "ec2:CreateSecurityGroup", "ec2:CreateRouteTable",
    "ec2:CreateInternetGateway", "ec2:CreateNatGateway", "ec2:AllocateAddress", "ec2:CreateVpcEndpoint",
    "ec2:CreateFlowLogs", "ec2:CreateLaunchTemplate",
    "eks:CreateCluster", "eks:CreateNodegroup", "eks:CreateAddon", "eks:CreateAccessEntry",
    "eks:CreatePodIdentityAssociation",
    "rds:CreateDBInstance", "rds:CreateDBSubnetGroup", "rds:CreateDBParameterGroup", "rds:CreateOptionGroup",
    "kms:CreateKey",
    "network-firewall:CreateFirewall", "network-firewall:CreateFirewallPolicy", "network-firewall:CreateRuleGroup",
    "logs:CreateLogGroup",
    "iam:CreateRole", "iam:CreatePolicy", "iam:CreateInstanceProfile",
    "ecr:CreateRepository",
  ]
}

variable "tags" {
  description = "Tags applied to the boundary policy."
  type        = map(string)
  default     = {}
}
