# aws-byoc-deployer-policy: what a principal needs to install the BYOC stack
# (network, EKS, RDS Postgres, KMS, S3 Object Lock, Network Firewall, Bedrock
# access) into ONE account, and nothing more.
#
# Two documents:
#   boundary         the ceiling. Attach it as the permissions boundary of the
#                    deployer role AND of every role the deployer creates (the
#                    deployer cannot create a role without it). Allows only the
#                    services the stack uses, in the allowed regions, and denies
#                    self-escalation and anything tagged as production.
#   deployer_policy  the deployer's own grant, narrower than the boundary: IAM
#                    only on "<name_prefix>-*" roles, S3 only on
#                    "<name_prefix>-*" buckets, and (with scope_tag) the root
#                    resources must carry the scope tag to be created or deleted.
#
# The same module serves the regulait-dev rehearsal role and a customer that
# wants its installer role scoped the same way.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  iam       = "arn:${local.partition}:iam::${local.account}"

  boundary_name = "${var.name_prefix}-byoc-boundary"
  boundary_arn  = "${local.iam}:policy/${local.boundary_name}"

  # Services the stack and its workload roles use. Anything not listed is out.
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
    "iam:*",
  ]

  # Actions that are not regional and so are exempt from the region lock.
  global_actions = ["iam:*", "sts:*"]

  forbidden_conditions = flatten([
    for k in var.forbidden_tag_keys : [
      { variable = "aws:ResourceTag/${k}", values = var.forbidden_tag_patterns },
      { variable = "aws:RequestTag/${k}", values = var.forbidden_tag_patterns },
    ]
  ])

  protected_roles = distinct(var.protected_role_arns)

  stack_roles             = "${local.iam}:role/${var.name_prefix}-*"
  stack_instance_profiles = "${local.iam}:instance-profile/${var.name_prefix}-*"
  stack_policies          = "${local.iam}:policy/${var.name_prefix}-*"
  stack_buckets           = "arn:${local.partition}:s3:::${var.name_prefix}-*"
  stack_repositories      = "arn:${local.partition}:ecr:*:${local.account}:repository/${var.name_prefix}*"

  # Root resources: created and deleted only with the scope tag.
  tagged_create_actions = [
    "ec2:CreateVpc",
    "eks:CreateCluster",
    "rds:CreateDBInstance",
    "kms:CreateKey",
    "network-firewall:CreateFirewall",
  ]
  tagged_delete_actions = [
    "ec2:DeleteVpc",
    "ec2:TerminateInstances",
    "eks:DeleteCluster",
    "eks:DeleteNodegroup",
    "rds:DeleteDBInstance",
    "kms:ScheduleKeyDeletion",
    "network-firewall:DeleteFirewall",
  ]
}

### Boundary ###

data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "StackServicesOnly"
    actions   = local.service_actions
    resources = ["*"]
  }

  statement {
    sid         = "AllowedRegionsOnly"
    effect      = "Deny"
    not_actions = local.global_actions
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = var.allowed_regions
    }
  }

  statement {
    sid    = "NoSelfEscalation"
    effect = "Deny"
    actions = [
      "iam:CreateUser",
      "iam:CreateAccessKey",
      "iam:CreateLoginProfile",
      "iam:UpdateLoginProfile",
      "iam:AttachUserPolicy",
      "iam:PutUserPolicy",
      "iam:AddUserToGroup",
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteUserPermissionsBoundary",
      "iam:CreateSAMLProvider",
      "iam:UpdateSAMLProvider",
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
    sid    = "BoundaryPolicyIsImmutable"
    effect = "Deny"
    actions = [
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.boundary_arn]
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

  # Production-tagged resources are off limits whatever else allows them.
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

  statement {
    sid    = "NoOrganizationOrAccountChanges"
    effect = "Deny"
    actions = [
      "organizations:*",
      "account:*",
      "sso:*",
      "sso-directory:*",
      "identitystore:*",
      "billing:*",
      "aws-portal:*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  description = "Permissions boundary for the BYOC deployer and every role it creates (${var.name_prefix})."
  policy      = data.aws_iam_policy_document.boundary.json
  tags        = var.tags
}

### Deployer's own grant ###

data "aws_iam_policy_document" "deployer" {
  statement {
    sid = "StackServices"
    # Everything in the boundary except IAM and S3, which are scoped below.
    actions   = [for a in local.service_actions : a if !startswith(a, "iam:") && !startswith(a, "s3:") && !startswith(a, "ecr:")]
    resources = ["*"]
  }

  statement {
    sid       = "StackRepositoriesOnly"
    actions   = ["ecr:*"]
    resources = [local.stack_repositories]
  }

  statement {
    sid = "EcrRegistryLevel"
    # Registry-level calls (login, pull-through cache rules for the stack's
    # own prefix, describing what exists) have no repository resource.
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:DescribeRepositories",
      "ecr:DescribeRegistry",
      "ecr:DescribePullThroughCacheRules",
      "ecr:CreatePullThroughCacheRule",
      "ecr:DeletePullThroughCacheRule",
      "ecr:UpdatePullThroughCacheRule",
      "ecr:ValidatePullThroughCacheRule",
      "ecr:BatchImportUpstreamImage",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "StackBucketsOnly"
    actions   = ["s3:*"]
    resources = [local.stack_buckets, "${local.stack_buckets}/*"]
  }

  statement {
    sid       = "ListBuckets"
    actions   = ["s3:ListAllMyBuckets", "s3:GetBucketLocation"]
    resources = ["*"]
  }

  statement {
    sid       = "IamRead"
    actions   = ["iam:Get*", "iam:List*"]
    resources = ["*"]
  }

  statement {
    sid       = "CreateStackRolesWithBoundaryOnly"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = [local.stack_roles]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
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
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [local.stack_roles]
  }

  statement {
    sid = "StackManagedPolicies"
    # Modules such as terraform-aws-modules/eks create their own policies
    # (cluster encryption, for example). They can only go on stack roles,
    # which carry the boundary, so they cannot grant beyond it.
    actions = [
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.stack_policies]
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
      values = [
        "eks.amazonaws.com",
        "ec2.amazonaws.com",
        "monitoring.rds.amazonaws.com",
        "pods.eks.amazonaws.com",
        "vpc-flow-logs.amazonaws.com",
      ]
    }
  }

  statement {
    sid = "StackInstanceProfiles"
    actions = [
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:TagInstanceProfile",
      "iam:UntagInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
    ]
    resources = [local.stack_instance_profiles]
  }

  statement {
    sid = "EksOidcProviders"
    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = ["${local.iam}:oidc-provider/oidc.eks.*.amazonaws.com/id/*"]
  }

  statement {
    sid       = "StackServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "eks.amazonaws.com",
        "eks-nodegroup.amazonaws.com",
        "rds.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "autoscaling.amazonaws.com",
        "network-firewall.amazonaws.com",
      ]
    }
  }

  dynamic "statement" {
    for_each = var.scope_tag == null ? [] : [var.scope_tag]
    content {
      sid       = "CreateRootResourcesWithScopeTagOnly"
      effect    = "Deny"
      actions   = local.tagged_create_actions
      resources = ["*"]
      condition {
        test     = "StringNotEquals"
        variable = "aws:RequestTag/${statement.value.key}"
        values   = [statement.value.value]
      }
    }
  }

  dynamic "statement" {
    for_each = var.scope_tag == null ? [] : [var.scope_tag]
    content {
      sid       = "DeleteRootResourcesWithScopeTagOnly"
      effect    = "Deny"
      actions   = local.tagged_delete_actions
      resources = ["*"]
      condition {
        test     = "StringNotEquals"
        variable = "aws:ResourceTag/${statement.value.key}"
        values   = [statement.value.value]
      }
    }
  }
}
