# aws-byoc-deployer-policy: what a principal needs to install the BYOC stack
# (network, EKS, RDS Postgres, KMS, S3 Object Lock, Network Firewall, Bedrock
# access) into ONE account, and nothing more.
#
# Three documents (ADR-0325, revised after the #854 security review):
#
#   boundary           the deployer's permissions boundary. IAM writes only on
#                      "<prefix>-*" roles, policies, instance profiles and EKS
#                      OIDC providers; a role can be created only with the
#                      WORKLOAD boundary on it; only listed or "<prefix>-*"
#                      policies can be attached; no trust-policy edits; no IAM
#                      users or keys; both boundaries and the deployer role are
#                      immutable; region lock; nothing tagged as production.
#
#   workload_boundary  the permissions boundary of every role the deployer
#                      creates (EKS cluster and nodes, VPC CNI, EBS CSI, load
#                      balancer controller, gateway, RDS monitoring, flow logs).
#                      No IAM write at all, so no stack role can make or widen a
#                      role. No web-identity (OIDC) session of such a role can act,
#                      so a role left behind with a GitHub trust cannot be used to
#                      skip the environment's reviewers. KMS, EC2 structure, S3,
#                      Logs and ECR writes limited to the stack's own resources.
#
#   deployer_policy    the deployer's own grant (inline, immutable under its
#                      boundary): the stack's services, with data and mutation
#                      limited to the stack's own resources (by name prefix where
#                      the ARN carries a name: RDS, Secrets Manager, Logs, EKS,
#                      Network Firewall, S3, ECR; by the scope tag where it does
#                      not: KMS, EC2), every tag-on-create create carrying the
#                      scope tag, and the scope tag never added to an existing
#                      EC2 resource.
#
# Trust-policy CONTENT cannot be conditioned in IAM. The controls for it are: no
# UpdateAssumeRolePolicy; roles only under the prefix and (with scope_tag) only
# tagged, so the rehearsal sweep finds them; the workload boundary's federated
# deny and its lack of IAM writes; and CloudTrail.
#
# The same module serves the regulait-dev rehearsal role and a customer that
# wants its installer role scoped the same way.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  iam       = "arn:${local.partition}:iam::${local.account}"
  p         = var.name_prefix

  boundary_name          = "${local.p}-byoc-boundary"
  boundary_arn           = "${local.iam}:policy/${local.boundary_name}"
  workload_boundary_name = "${local.p}-byoc-workload-boundary"
  workload_boundary_arn  = "${local.iam}:policy/${local.workload_boundary_name}"

  stack_roles             = "${local.iam}:role/${local.p}-*"
  stack_instance_profiles = "${local.iam}:instance-profile/${local.p}-*"
  stack_policies          = "${local.iam}:policy/${local.p}-*"
  eks_oidc_providers      = "${local.iam}:oidc-provider/oidc.eks.*.amazonaws.com/id/*"
  stack_buckets           = "arn:${local.partition}:s3:::${local.p}-*"
  stack_repositories      = "arn:${local.partition}:ecr:*:${local.account}:repository/${local.p}*"

  tag_guard = var.scope_tag != null

  # Non-IAM services the stack and its workload roles use. IAM is granted
  # separately, scoped to the stack's own resources.
  service_actions = [
    "ec2:*",
    "eks:*",
    "eks-auth:AssumeRoleForPodIdentity",
    "rds:*",
    "rds-db:connect",
    "kms:*",
    "s3:*",
    "logs:*",
    "cloudwatch:*",
    "secretsmanager:*",
    "elasticloadbalancing:*",
    "autoscaling:*",
    "network-firewall:*",
    "acm:*",
    "ecr:*",
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:Converse",
    "bedrock:ConverseStream",
    "bedrock:Get*",
    "bedrock:List*",
    "ssm:GetParameter",
    "ssm:GetParameters",
    "servicequotas:GetServiceQuota",
    "servicequotas:ListServiceQuotas",
    "tag:GetResources",
    "sts:GetCallerIdentity",
  ]

  # IAM changes a stack role may make, on stack roles only. No
  # UpdateAssumeRolePolicy: trust is set once, at create time.
  role_write_actions = [
    "iam:CreateRole",
    "iam:DeleteRole",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:UpdateRole",
    "iam:UpdateRoleDescription",
    "iam:PutRolePermissionsBoundary",
    "iam:PutRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
  ]

  policy_write_actions = [
    "iam:CreatePolicy",
    "iam:DeletePolicy",
    "iam:CreatePolicyVersion",
    "iam:DeletePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "iam:TagPolicy",
    "iam:UntagPolicy",
  ]

  instance_profile_actions = [
    "iam:CreateInstanceProfile",
    "iam:DeleteInstanceProfile",
    "iam:TagInstanceProfile",
    "iam:UntagInstanceProfile",
    "iam:AddRoleToInstanceProfile",
    "iam:RemoveRoleFromInstanceProfile",
  ]

  oidc_provider_actions = [
    "iam:CreateOpenIDConnectProvider",
    "iam:DeleteOpenIDConnectProvider",
    "iam:TagOpenIDConnectProvider",
    "iam:UntagOpenIDConnectProvider",
  ]

  service_linked_roles = [
    "eks.amazonaws.com",
    "eks-nodegroup.amazonaws.com",
    "rds.amazonaws.com",
    "elasticloadbalancing.amazonaws.com",
    "autoscaling.amazonaws.com",
    "network-firewall.amazonaws.com",
  ]

  passable_to = [
    "eks.amazonaws.com",
    "ec2.amazonaws.com",
    "monitoring.rds.amazonaws.com",
    "pods.eks.amazonaws.com",
    "vpc-flow-logs.amazonaws.com",
  ]

  # Name-scoped resources: everything outside these is off limits for the
  # service's non-read actions.
  stack_rds         = "arn:${local.partition}:rds:*:${local.account}:*:${local.p}*"
  stack_secrets     = "arn:${local.partition}:secretsmanager:*:${local.account}:secret:${local.p}*"
  stack_rds_db      = "arn:${local.partition}:rds:*:${local.account}:db:${local.p}*"
  stack_eks         = ["arn:${local.partition}:eks:*:${local.account}:cluster/${local.p}-*", "arn:${local.partition}:eks:*:${local.account}:*/${local.p}-*/*"]
  stack_firewall    = "arn:${local.partition}:network-firewall:*:${local.account}:*/${local.p}-*"
  stack_kms_aliases = "arn:${local.partition}:kms:*:${local.account}:alias/${local.p}-*"
  stack_log_groups = flatten([for g in ["/${local.p}/*", "/aws/eks/${local.p}-*", "/aws/rds/instance/${local.p}-*"] : [
    "arn:${local.partition}:logs:*:${local.account}:log-group:${g}",
    "arn:${local.partition}:logs:*:${local.account}:log-group:${g}:*",
  ]])

  # EC2 changes to instances, volumes, snapshots, routing and VPC structure:
  # allowed only on resources carrying the scope tag. Security groups and
  # network interfaces are left out here because the VPC CNI, the EKS cluster
  # role and the load balancer controller manage their own untagged ones; the
  # deployer's own grant limits security-group changes further.
  ec2_guarded_actions = [
    "ec2:TerminateInstances",
    "ec2:StopInstances",
    "ec2:RebootInstances",
    "ec2:ModifyInstanceAttribute",
    "ec2:ModifyInstanceMetadataOptions",
    "ec2:AssociateIamInstanceProfile",
    "ec2:ReplaceIamInstanceProfileAssociation",
    "ec2:DisassociateIamInstanceProfile",
    "ec2:GetPasswordData",
    "ec2:CreateSnapshot",
    "ec2:CreateSnapshots",
    "ec2:CreateImage",
    "ec2:ModifySnapshotAttribute",
    "ec2:DeleteSnapshot",
    "ec2:AttachVolume",
    "ec2:DetachVolume",
    "ec2:DeleteVolume",
    "ec2:DeleteVpc",
    "ec2:ModifyVpcAttribute",
    "ec2:DeleteSubnet",
    "ec2:ModifySubnetAttribute",
    "ec2:CreateRoute",
    "ec2:ReplaceRoute",
    "ec2:DeleteRoute",
    "ec2:DeleteRouteTable",
    "ec2:AssociateRouteTable",
    "ec2:DisassociateRouteTable",
    "ec2:ReplaceRouteTableAssociation",
    "ec2:AttachInternetGateway",
    "ec2:DetachInternetGateway",
    "ec2:DeleteInternetGateway",
    "ec2:DeleteNatGateway",
    "ec2:ReleaseAddress",
    "ec2:DisassociateAddress",
    "ec2:DeleteVpcEndpoints",
    "ec2:ModifyVpcEndpoint",
    "ec2:DeleteFlowLogs",
    "ec2:DeleteLaunchTemplate",
    "ec2:ModifyLaunchTemplate",
    "ec2:CreateLaunchTemplateVersion",
    "ec2:DeleteNetworkAcl",
    "ec2:CreateNetworkAclEntry",
    "ec2:ReplaceNetworkAclEntry",
    "ec2:DeleteNetworkAclEntry",
    "ec2:ReplaceNetworkAclAssociation",
  ]

  # Write and data verbs per service (reads that take no resource, such as
  # List* and Describe* on "*", are left alone).
  rds_write_actions = [
    "rds:Create*", "rds:Delete*", "rds:Modify*", "rds:Reboot*", "rds:Start*", "rds:Stop*", "rds:Restore*",
    "rds:Copy*", "rds:Failover*", "rds:Promote*", "rds:Switchover*", "rds:Add*", "rds:Remove*", "rds:Download*",
  ]
  eks_write_actions = [
    "eks:Create*", "eks:Delete*", "eks:Update*", "eks:Associate*", "eks:Disassociate*", "eks:Register*",
    "eks:Deregister*", "eks:Put*", "eks:TagResource", "eks:UntagResource", "eks:AccessKubernetesApi",
    "eks-auth:AssumeRoleForPodIdentity",
  ]
  firewall_write_actions = [
    "network-firewall:Create*", "network-firewall:Delete*", "network-firewall:Update*",
    "network-firewall:Associate*", "network-firewall:Disassociate*", "network-firewall:Put*",
    "network-firewall:TagResource", "network-firewall:UntagResource",
  ]
  ecr_write_actions = [
    "ecr:CreateRepository", "ecr:DeleteRepository*", "ecr:Put*", "ecr:Initiate*", "ecr:Upload*", "ecr:Complete*",
    "ecr:BatchDelete*", "ecr:Set*", "ecr:DeleteLifecyclePolicy", "ecr:*TagResource", "ecr:BatchImport*",
  ]
  logs_guarded_actions = [
    "logs:DeleteLogGroup", "logs:DeleteLogStream", "logs:*RetentionPolicy", "logs:*KmsKey", "logs:*SubscriptionFilter",
    "logs:*DataProtectionPolicy", "logs:*TagResource", "logs:*TagLogGroup", "logs:GetLogEvents", "logs:FilterLogEvents",
    "logs:StartQuery", "logs:CreateExportTask",
  ]

  # KMS keys have no name in the ARN: tag-guarded. Every key verb except
  # CreateKey (which must carry the tag) and account-level listings.
  kms_key_actions = [
    "kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:*Mac", "kms:Sign", "kms:Verify",
    "kms:DeriveSharedSecret", "kms:*Grant", "kms:*KeyPolicy", "kms:DisableKey*", "kms:EnableKey*",
    "kms:*KeyDeletion", "kms:RotateKeyOnDemand", "kms:UpdateKeyDescription", "kms:*TagResource", "kms:*Alias",
    "kms:*KeyMaterial", "kms:ReplicateKey", "kms:UpdatePrimaryRegion",
  ]

  forbidden_conditions = flatten([
    for k in var.forbidden_tag_keys : [
      { variable = "aws:ResourceTag/${k}", values = var.forbidden_tag_patterns },
      { variable = "aws:RequestTag/${k}", values = var.forbidden_tag_patterns },
    ]
  ])

  protected_roles = distinct(var.protected_role_arns)

  # What the workload roles (EKS cluster and nodes, VPC CNI, EBS CSI, load
  # balancer controller, gateway, RDS monitoring, flow logs) use. No IAM write
  # at all, and no Secrets Manager, RDS or Network Firewall.
  workload_actions = [
    "ec2:*",
    "elasticloadbalancing:*",
    "autoscaling:Describe*",
    "kms:*",
    "s3:*",
    "logs:*",
    "cloudwatch:PutMetricData",
    "ecr:*",
    "eks:Describe*",
    "eks:List*",
    "eks-auth:AssumeRoleForPodIdentity",
    "acm:Describe*",
    "acm:List*",
    "acm:Get*",
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:Converse",
    "bedrock:ConverseStream",
    "iam:Get*",
    "iam:List*",
    "tag:GetResources",
    "sts:GetCallerIdentity",
  ]
}


locals {
  # Guards shared by the workload boundary and the deployer policy, as
  # statement objects so both documents render the same rules.
  name_guards = [
    { sid = "RdsOnlyStackResources", actions = local.rds_write_actions, not_resources = [local.stack_rds], conditions = [] },
    { sid = "SecretsOnlyStackSecrets", actions = ["secretsmanager:*"], not_resources = [local.stack_secrets], conditions = [
      # RDS-managed master secrets are named rds!..., so they are recognised by
      # the tag RDS puts on them instead.
      { test = "StringNotLike", variable = "aws:ResourceTag/aws:rds:primaryDBInstanceArn", values = [local.stack_rds_db] },
    ] },
    { sid = "LogsOnlyStackLogGroups", actions = local.logs_guarded_actions, not_resources = local.stack_log_groups, conditions = [] },
    { sid = "EksOnlyStackClusters", actions = local.eks_write_actions, not_resources = local.stack_eks, conditions = [] },
    { sid = "NetworkFirewallOnlyStack", actions = local.firewall_write_actions, not_resources = [local.stack_firewall], conditions = [] },
    { sid = "S3OnlyStackBuckets", actions = ["s3:*"], not_resources = [local.stack_buckets, "${local.stack_buckets}/*"], conditions = [] },
    # Writes only: nodes pull EKS add-on images from AWS-owned repositories.
    { sid = "EcrOnlyStackRepositories", actions = local.ecr_write_actions, not_resources = [local.stack_repositories], conditions = [] },
  ]

  tag_guards = local.tag_guard ? [
    { sid = "KmsOnlyScopeTaggedKeys", actions = local.kms_key_actions, not_resources = [local.stack_kms_aliases], conditions = [
      { test = "StringNotEquals", variable = "aws:ResourceTag/${var.scope_tag.key}", values = [var.scope_tag.value] },
    ] },
    { sid = "Ec2StructureOnlyScopeTagged", actions = local.ec2_guarded_actions, not_resources = [], conditions = [
      { test = "StringNotEquals", variable = "aws:ResourceTag/${var.scope_tag.key}", values = [var.scope_tag.value] },
    ] },
    # Nobody may put the scope tag on something that does not already carry
    # it, except while creating it, so the tag guards cannot be met by
    # retagging.
    { sid = "NoRetaggingIntoScope", actions = ["ec2:CreateTags"], not_resources = [], conditions = [
      { test = "ForAnyValue:StringEquals", variable = "aws:TagKeys", values = [var.scope_tag.key] },
      { test = "StringNotEquals", variable = "aws:ResourceTag/${var.scope_tag.key}", values = [var.scope_tag.value] },
      { test = "Null", variable = "ec2:CreateAction", values = ["true"] },
    ] },
  ] : []

  workload_guards = [for g in concat(local.name_guards, local.tag_guards) : g if !contains(["RdsOnlyStackResources", "SecretsOnlyStackSecrets", "EksOnlyStackClusters", "NetworkFirewallOnlyStack"], g.sid)]
}

### Deployer boundary ###

data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "StackServices"
    actions   = local.service_actions
    resources = ["*"]
  }

  statement {
    sid       = "IamRead"
    actions   = ["iam:Get*", "iam:List*"]
    resources = ["*"]
  }

  # IAM writes only on the stack's own roles, policies, instance profiles and
  # EKS OIDC providers; the denies below narrow these further.
  statement {
    sid       = "IamStackOnly"
    actions   = ["iam:*"]
    resources = [local.stack_roles, local.stack_policies, local.stack_instance_profiles, local.eks_oidc_providers]
  }

  statement {
    sid       = "IamServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = local.service_linked_roles
    }
  }

  statement {
    sid       = "RolesOnlyWithTheWorkloadBoundary"
    effect    = "Deny"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.workload_boundary_arn]
    }
  }

  statement {
    sid       = "AttachOnlyListedOrStackPolicies"
    effect    = "Deny"
    actions   = ["iam:AttachRolePolicy"]
    resources = ["*"]
    condition {
      test     = "ArnNotLike"
      variable = "iam:PolicyARN"
      values   = concat(var.attachable_managed_policy_arns, [local.stack_policies])
    }
  }

  statement {
    sid           = "RoleChangesOnlyOnStackRoles"
    effect        = "Deny"
    actions       = concat(local.role_write_actions, ["iam:PassRole"])
    not_resources = [local.stack_roles]
  }

  statement {
    sid       = "NoTrustPolicyEdits"
    effect    = "Deny"
    actions   = ["iam:UpdateAssumeRolePolicy"]
    resources = ["*"]
  }

  statement {
    sid           = "OidcProvidersOnlyForEks"
    effect        = "Deny"
    actions       = local.oidc_provider_actions
    not_resources = [local.eks_oidc_providers]
  }

  statement {
    sid    = "NoUsersKeysOrBoundaryRemoval"
    effect = "Deny"
    actions = [
      "iam:*User*",
      "iam:*AccessKey*",
      "iam:*LoginProfile",
      "iam:DeleteRolePermissionsBoundary",
      "iam:*SAMLProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
    ]
    resources = ["*"]
  }

  statement {
    sid           = "NoPolicyVersionsOutsideTheStack"
    effect        = "Deny"
    actions       = ["iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion"]
    not_resources = [local.stack_policies]
  }

  statement {
    sid       = "BoundariesAreImmutable"
    effect    = "Deny"
    actions   = local.policy_write_actions
    resources = [local.boundary_arn, local.workload_boundary_arn]
  }

  dynamic "statement" {
    for_each = length(local.protected_roles) > 0 ? [1] : []
    content {
      sid       = "ProtectedRolesAreImmutable"
      effect    = "Deny"
      actions   = ["iam:*"]
      resources = local.protected_roles
    }
  }

  statement {
    sid         = "AllowedRegionsOnly"
    effect      = "Deny"
    not_actions = ["iam:*", "sts:*"]
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = var.allowed_regions
    }
  }

  dynamic "statement" {
    for_each = local.forbidden_conditions
    content {
      sid       = "NoProduction${replace(title(replace(statement.value.variable, "/[^A-Za-z0-9]+/", " ")), " ", "")}"
      effect    = "Deny"
      actions   = ["*"]
      resources = ["*"]
      condition {
        test     = "StringLike"
        variable = statement.value.variable
        values   = statement.value.values
      }
    }
  }
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  description = "Permissions boundary for the BYOC deployer (${local.p}). Roles it creates carry ${local.workload_boundary_name}."
  policy      = data.aws_iam_policy_document.boundary.json
  tags        = var.tags
}

### Workload boundary ###

data "aws_iam_policy_document" "workload_boundary" {
  statement {
    sid       = "WorkloadServices"
    actions   = local.workload_actions
    resources = ["*"]
  }

  statement {
    sid       = "ServiceLinkedRolesOnly"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = local.service_linked_roles
    }
  }

  # Stack roles are assumed by AWS services (EKS, EC2, Pod Identity, RDS
  # monitoring, flow logs), never in a web-identity session. One created with
  # an OIDC trust (a GitHub subject, say) therefore gets nothing.
  statement {
    sid       = "NoWebIdentitySessions"
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:FederatedProvider"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = local.workload_guards
    content {
      sid           = statement.value.sid
      effect        = "Deny"
      actions       = statement.value.actions
      resources     = length(statement.value.not_resources) == 0 ? ["*"] : null
      not_resources = length(statement.value.not_resources) > 0 ? statement.value.not_resources : null
      dynamic "condition" {
        for_each = statement.value.conditions
        content {
          test     = condition.value.test
          variable = condition.value.variable
          values   = condition.value.values
        }
      }
    }
  }

  statement {
    sid         = "AllowedRegionsOnly"
    effect      = "Deny"
    not_actions = ["iam:*", "sts:*"]
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = var.allowed_regions
    }
  }

  dynamic "statement" {
    for_each = local.forbidden_conditions
    content {
      sid       = "NoProduction${replace(title(replace(statement.value.variable, "/[^A-Za-z0-9]+/", " ")), " ", "")}"
      effect    = "Deny"
      actions   = ["*"]
      resources = ["*"]
      condition {
        test     = "StringLike"
        variable = statement.value.variable
        values   = statement.value.values
      }
    }
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = local.workload_boundary_name
  description = "Permissions boundary for every role the BYOC deployer creates (${local.p}). No IAM writes."
  policy      = data.aws_iam_policy_document.workload_boundary.json
  tags        = var.tags
}

### Deployer's own grant ###

data "aws_iam_policy_document" "deployer" {
  statement {
    sid       = "StackServices"
    actions   = local.service_actions
    resources = ["*"]
  }

  statement {
    sid       = "IamRead"
    actions   = ["iam:Get*", "iam:List*"]
    resources = ["*"]
  }

  statement {
    sid       = "CreateStackRolesWithWorkloadBoundaryOnly"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = [local.stack_roles]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.workload_boundary_arn]
    }
  }

  statement {
    sid = "ManageStackRoles"
    actions = [
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [local.stack_roles]
  }

  statement {
    sid       = "AttachListedOrStackPoliciesOnly"
    actions   = ["iam:AttachRolePolicy"]
    resources = [local.stack_roles]
    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values   = concat(var.attachable_managed_policy_arns, [local.stack_policies])
    }
  }

  statement {
    sid       = "PassStackRolesToStackServices"
    actions   = ["iam:PassRole"]
    resources = [local.stack_roles]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = local.passable_to
    }
  }

  statement {
    sid       = "StackManagedPolicies"
    actions   = local.policy_write_actions
    resources = [local.stack_policies]
  }

  statement {
    sid       = "StackInstanceProfiles"
    actions   = local.instance_profile_actions
    resources = [local.stack_instance_profiles]
  }

  statement {
    sid       = "EksOidcProviders"
    actions   = local.oidc_provider_actions
    resources = [local.eks_oidc_providers]
  }

  statement {
    sid       = "StackServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = local.service_linked_roles
    }
  }

  dynamic "statement" {
    for_each = concat(local.name_guards, local.tag_guards)
    content {
      sid           = statement.value.sid
      effect        = "Deny"
      actions       = statement.value.actions
      resources     = length(statement.value.not_resources) == 0 ? ["*"] : null
      not_resources = length(statement.value.not_resources) > 0 ? statement.value.not_resources : null
      dynamic "condition" {
        for_each = statement.value.conditions
        content {
          test     = condition.value.test
          variable = condition.value.variable
          values   = condition.value.values
        }
      }
    }
  }

  # Every create that supports tag-on-create carries the scope tag, so the tag
  # guards and the rehearsal sweep see everything the deployer made.
  dynamic "statement" {
    for_each = local.tag_guard ? [var.scope_tag] : []
    content {
      sid       = "CreatesCarryTheScopeTag"
      effect    = "Deny"
      actions   = var.tagged_create_actions
      resources = ["*"]
      condition {
        test     = "StringNotEquals"
        variable = "aws:RequestTag/${statement.value.key}"
        values   = [statement.value.value]
      }
    }
  }

  dynamic "statement" {
    for_each = local.tag_guard ? [var.scope_tag] : []
    content {
      sid    = "SecurityGroupChangesOnlyScopeTagged"
      effect = "Deny"
      actions = [
        "ec2:DeleteSecurityGroup",
        "ec2:RevokeSecurityGroup*",
        "ec2:ModifySecurityGroupRules",
        "ec2:UpdateSecurityGroupRuleDescriptions*",
      ]
      resources = ["*"]
      condition {
        test     = "StringNotEquals"
        variable = "aws:ResourceTag/${statement.value.key}"
        values   = [statement.value.value]
      }
    }
  }
}
