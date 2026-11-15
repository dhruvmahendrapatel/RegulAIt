# Offline plan-only tests: no AWS call is made (fake credentials, every
# account lookup skipped, the two account data sources overridden).
# Each assertion pins one guard the security review of #854 asked for.

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "111111111111" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

variables {
  name_prefix         = "regulait-rehearsal"
  allowed_regions     = ["us-east-1"]
  scope_tag           = { key = "purpose", value = "rehearsal" }
  protected_role_arns = ["arn:aws:iam::111111111111:role/gh-actions-regulait-rehearsal"]
}

run "boundary_iam_cannot_be_escaped" {
  command = plan

  # No allow of "*", and IAM writes only on the stack's own IAM resources.
  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : !(s.Effect == "Allow" && contains(flatten([try(s.Action, [])]), "*"))])
    error_message = "The deployer boundary must not allow *."
  }

  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : !(s.Effect == "Allow" && contains(flatten([try(s.Action, [])]), "iam:*") && contains(flatten([try(s.Resource, [])]), "*"))])
    error_message = "iam:* must never be allowed on every resource."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "IamStackOnly" && sort(flatten([s.Resource])) == sort(["arn:aws:iam::111111111111:role/regulait-rehearsal-*", "arn:aws:iam::111111111111:policy/regulait-rehearsal-*", "arn:aws:iam::111111111111:instance-profile/regulait-rehearsal-*", "arn:aws:iam::111111111111:oidc-provider/oidc.eks.*.amazonaws.com/id/*"])]) == 1
    error_message = "IAM writes must be scoped to the stack prefix."
  }

  # Roles the deployer creates can write no IAM at all.
  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : !(s.Effect == "Allow" && anytrue([for a in flatten([try(s.Action, [])]) : startswith(a, "iam:") && !contains(["iam:Get*", "iam:List*", "iam:CreateServiceLinkedRole"], a)]))])
    error_message = "The workload boundary must allow no IAM write except service-linked roles."
  }

  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : !(s.Effect == "Allow" && anytrue([for a in flatten([try(s.Action, [])]) : startswith(a, "secretsmanager:") || startswith(a, "rds:") || startswith(a, "network-firewall:") || a == "*"]))])
    error_message = "The workload boundary must not reach Secrets Manager, RDS or Network Firewall."
  }

  # A role can be created (or re-bounded) only with this boundary.
  assert {
    condition = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if
      s.Sid == "RolesOnlyWithTheWorkloadBoundary" && s.Effect == "Deny" &&
      contains(flatten([s.Action]), "iam:CreateRole") && contains(flatten([s.Action]), "iam:PutRolePermissionsBoundary") &&
    try(s.Condition.StringNotEquals["iam:PermissionsBoundary"], "") == "arn:aws:iam::111111111111:policy/regulait-rehearsal-byoc-workload-boundary"]) == 1
    error_message = "The deployer boundary must deny creating a role without the workload boundary."
  }

  # Only listed or stack policies can be attached.
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "AttachOnlyListedOrStackPolicies" && s.Effect == "Deny" && contains(flatten([try(s.Condition.ArnNotLike["iam:PolicyARN"], [])]), "arn:aws:iam::111111111111:policy/regulait-rehearsal-*") && !contains(flatten([try(s.Condition.ArnNotLike["iam:PolicyARN"], [])]), "arn:aws:iam::aws:policy/AdministratorAccess")]) == 1
    error_message = "AttachRolePolicy must be denied outside the listed and stack policies."
  }

  # Role and policy changes and PassRole are denied outside the stack roles.
  assert {
    condition = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if
      s.Sid == "RoleChangesOnlyOnStackRoles" && s.Effect == "Deny" && try(s.NotResource, "") == "arn:aws:iam::111111111111:role/regulait-rehearsal-*" &&
    alltrue([for a in ["iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PassRole", "iam:CreateRole"] : contains(flatten([s.Action]), a)])]) == 1
    error_message = "Role changes and PassRole must be denied outside the stack roles."
  }

  # Trust policies are never edited.
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "NoTrustPolicyEdits" && s.Effect == "Deny" && contains(flatten([s.Action]), "iam:UpdateAssumeRolePolicy")]) == 1
    error_message = "UpdateAssumeRolePolicy must be denied."
  }

  # OIDC providers only for EKS.
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "OidcProvidersOnlyForEks" && s.Effect == "Deny" && try(s.NotResource, "") == "arn:aws:iam::111111111111:oidc-provider/oidc.eks.*.amazonaws.com/id/*"]) == 1
    error_message = "OIDC providers must be limited to EKS."
  }

  # A web-identity session of a stack role gets nothing.
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : s if s.Sid == "NoWebIdentitySessions" && s.Effect == "Deny" && try(s.Condition.Null["aws:FederatedProvider"], "") == "false"]) == 1
    error_message = "Federated sessions of stack roles must be denied."
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : try(s.Action, []) if s.Sid == "NoUsersKeysOrBoundaryRemoval"]), "iam:*AccessKey*")
    error_message = "The boundary must deny access keys."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "BoundariesAreImmutable" && contains(flatten([try(s.Action, [])]), "iam:CreatePolicyVersion") && sort(flatten([s.Resource])) == sort(["arn:aws:iam::111111111111:policy/regulait-rehearsal-byoc-boundary", "arn:aws:iam::111111111111:policy/regulait-rehearsal-byoc-workload-boundary"])]) == 1
    error_message = "No one under the deployer boundary may version or delete either boundary."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "ProtectedRolesAreImmutable" && try(s.Resource, "") == "arn:aws:iam::111111111111:role/gh-actions-regulait-rehearsal"]) == 1
    error_message = "The deployer role itself must be immutable under the boundary."
  }
}

run "data_and_mutation_limited_to_the_stack" {
  command = plan

  assert {
    condition = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if
      s.Sid == "SecretsOnlyStackSecrets" && s.Effect == "Deny" && contains(flatten([s.Action]), "secretsmanager:*") &&
    try(s.NotResource, "") == "arn:aws:secretsmanager:*:111111111111:secret:regulait-rehearsal*"]) == 1
    error_message = "Secrets outside the stack must be denied to the deployer (GetSecretValue included)."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "RdsOnlyStackResources" && contains(flatten([s.Action]), "rds:Delete*") && contains(flatten([s.Action]), "rds:Modify*") && try(s.NotResource, "") == "arn:aws:rds:*:111111111111:*:regulait-rehearsal*"]) == 1
    error_message = "RDS changes (clusters included) must be limited to the stack's names."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if contains(["EksOnlyStackClusters", "NetworkFirewallOnlyStack"], s.Sid) && s.Effect == "Deny" && can(s.NotResource)]) == 2
    error_message = "EKS and Network Firewall changes must be limited to the stack's names."
  }

  # The guards that apply to workload roles too are in both documents.
  assert {
    condition     = alltrue([for doc in [jsondecode(data.aws_iam_policy_document.deployer.json).Statement, jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement] : length([for s in doc : s if contains(["LogsOnlyStackLogGroups", "S3OnlyStackBuckets", "EcrOnlyStackRepositories", "KmsOnlyScopeTaggedKeys", "Ec2StructureOnlyScopeTagged", "NoRetaggingIntoScope"], s.Sid) && s.Effect == "Deny"]) == 6])
    error_message = "Logs, S3, ECR, KMS and EC2 guards must bind the deployer and every workload role."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : s if s.Sid == "KmsOnlyScopeTaggedKeys" && contains(flatten([s.Action]), "kms:Decrypt") && contains(flatten([s.Action]), "kms:*KeyPolicy") && contains(flatten([s.Action]), "kms:DisableKey*") && try(s.Condition.StringNotEquals["aws:ResourceTag/purpose"], "") == "rehearsal"]) == 1
    error_message = "KMS use and policy changes must be limited to scope-tagged keys."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : s if s.Sid == "Ec2StructureOnlyScopeTagged" && contains(flatten([s.Action]), "ec2:ModifyInstanceAttribute") && contains(flatten([s.Action]), "ec2:DeleteSubnet") && contains(flatten([s.Action]), "ec2:CreateSnapshot")]) == 1
    error_message = "EC2 structure changes must be limited to scope-tagged resources."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : s if s.Sid == "LogsOnlyStackLogGroups" && contains(flatten([s.Action]), "logs:DeleteLogGroup") && contains(flatten([s.NotResource]), "arn:aws:logs:*:111111111111:log-group:/aws/eks/regulait-rehearsal-*")]) == 1
    error_message = "Log group deletes and reads must be limited to the stack's log groups."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : s if s.Sid == "NoRetaggingIntoScope" && try(s.Condition.Null["ec2:CreateAction"], "") == "true"]) == 1
    error_message = "The scope tag must not be addable to an existing resource."
  }

  # A Deny with NotAction and NotResource would reach every other service.
  assert {
    condition     = alltrue([for doc in [jsondecode(data.aws_iam_policy_document.deployer.json).Statement, jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement, jsondecode(data.aws_iam_policy_document.boundary.json).Statement] : alltrue([for s in doc : !(s.Effect == "Deny" && can(s.NotAction) && can(s.NotResource))])])
    error_message = "No Deny may combine NotAction and NotResource."
  }

  assert {
    condition     = alltrue([for doc in [jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement, jsondecode(data.aws_iam_policy_document.boundary.json).Statement] : length([for s in doc : s if s.Sid == "AllowedRegionsOnly" && s.Effect == "Deny" && try(s.Condition.StringNotEquals["aws:RequestedRegion"], "") == "us-east-1"]) == 1])
    error_message = "Both boundaries must deny every regional action outside the allowed regions."
  }

  assert {
    condition     = alltrue([for doc in [jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement, jsondecode(data.aws_iam_policy_document.boundary.json).Statement] : length([for s in doc : s if startswith(s.Sid, "NoProduction") && s.Effect == "Deny"]) == 4])
    error_message = "Each forbidden tag key must be denied as both a resource tag and a request tag, in both boundaries."
  }

  assert {
    condition     = length(replace(data.aws_iam_policy_document.boundary.json, "/\\s/", "")) <= 6144 && length(replace(data.aws_iam_policy_document.workload_boundary.json, "/\\s/", "")) <= 6144
    error_message = "A boundary exceeds the 6,144-character managed policy limit (whitespace excluded)."
  }
}

run "deployer_creates_are_tagged_and_scoped" {
  command = plan

  assert {
    condition = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if
      s.Sid == "CreateStackRolesWithWorkloadBoundaryOnly" && try(s.Resource, "") == "arn:aws:iam::111111111111:role/regulait-rehearsal-*" &&
    try(s.Condition.StringEquals["iam:PermissionsBoundary"], "") == "arn:aws:iam::111111111111:policy/regulait-rehearsal-byoc-workload-boundary"]) == 1
    error_message = "CreateRole must be limited to the prefix and require the workload boundary."
  }

  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : !(s.Effect == "Allow" && (contains(flatten([try(s.Action, [])]), "iam:*") || contains(flatten([try(s.Action, [])]), "iam:UpdateAssumeRolePolicy") || contains(flatten([try(s.Action, [])]), "iam:CreateUser")))])
    error_message = "The deployer must hold no blanket IAM, no trust edits and no user creation."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "CreatesCarryTheScopeTag" && alltrue([for a in ["ec2:CreateSubnet", "ec2:CreateSecurityGroup", "eks:CreateNodegroup", "rds:CreateDBSubnetGroup", "iam:CreateRole", "kms:CreateKey"] : contains(flatten([s.Action]), a)]) && try(s.Condition.StringNotEquals["aws:RequestTag/purpose"], "") == "rehearsal"]) == 1
    error_message = "Every tag-on-create create must carry the scope tag."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "SecurityGroupChangesOnlyScopeTagged"]) == 1
    error_message = "The deployer may change only scope-tagged security groups."
  }

  assert {
    condition     = length(replace(data.aws_iam_policy_document.deployer.json, "/\\s/", "")) <= 10240
    error_message = "The deployer policy exceeds the 10,240-character inline role policy limit."
  }
}

run "no_scope_tag_keeps_the_name_guards" {
  command = plan

  variables {
    scope_tag = null
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "CreatesCarryTheScopeTag"]) == 0 && length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "KmsOnlyScopeTaggedKeys"]) == 0
    error_message = "scope_tag = null turns the tag checks off."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if contains(["SecretsOnlyStackSecrets", "RdsOnlyStackResources"], s.Sid)]) == 2 && length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "RolesOnlyWithTheWorkloadBoundary"]) == 1 && length([for s in jsondecode(data.aws_iam_policy_document.workload_boundary.json).Statement : s if s.Sid == "NoWebIdentitySessions"]) == 1
    error_message = "Name and IAM guards hold without a scope tag."
  }
}
