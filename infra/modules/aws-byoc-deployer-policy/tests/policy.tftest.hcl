# Offline plan-only tests: no AWS call is made (fake credentials, every
# account lookup skipped, the two account data sources overridden).

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

run "boundary_locks_region_escalation_and_production" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "AllowedRegionsOnly" && s.Effect == "Deny" && try(s.Condition.StringNotEquals["aws:RequestedRegion"], null) == "us-east-1"]) == 1
    error_message = "The boundary must deny every regional action outside the allowed regions."
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : try(s.Action, []) if s.Sid == "NoSelfEscalation"]), "iam:DeleteRolePermissionsBoundary")
    error_message = "The boundary must deny removing a permissions boundary."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if startswith(s.Sid, "NoProduction") && s.Effect == "Deny"]) == 8
    error_message = "Each forbidden tag key must be denied as both a resource tag and a request tag."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "ProtectedRolesAreImmutable" && try(s.Resource, "") == "arn:aws:iam::111111111111:role/gh-actions-regulait-rehearsal"]) == 1
    error_message = "The deployer role itself must be immutable under the boundary."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s if s.Sid == "BoundaryPolicyIsImmutable" && contains(flatten([try(s.Action, [])]), "iam:CreatePolicyVersion") && try(s.Resource, "") == "arn:aws:iam::111111111111:policy/regulait-rehearsal-byoc-boundary"]) == 1
    error_message = "No one under the boundary may version or delete the boundary itself."
  }

  assert {
    condition     = !contains(flatten([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : try(s.Action, []) if s.Effect == "Allow"]), "*")
    error_message = "The boundary must never allow every action."
  }
}

run "deployer_roles_need_the_boundary_and_the_prefix" {
  command = plan

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.boundary.json))) < 6144
    error_message = "The boundary exceeds the 6,144-character managed policy limit."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployer.json))) < 10240
    error_message = "The deployer policy exceeds the 10,240-character inline role policy limit."
  }

  assert {
    condition = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if
      s.Sid == "CreateStackRolesWithBoundaryOnly" &&
      try(s.Resource, "") == "arn:aws:iam::111111111111:role/regulait-rehearsal-*" &&
    try(s.Condition.StringEquals["iam:PermissionsBoundary"], null) == "arn:aws:iam::111111111111:policy/regulait-rehearsal-byoc-boundary"]) == 1
    error_message = "CreateRole must be limited to the prefix and require the boundary."
  }

  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : !contains(flatten([try(s.Action, [])]), "iam:*") && !contains(flatten([try(s.Action, [])]), "iam:CreateUser")])
    error_message = "The deployer must hold no blanket IAM grant and no user creation."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "StackBucketsOnly" && contains(try(flatten([s.Resource]), []), "arn:aws:s3:::regulait-rehearsal-*")]) == 1
    error_message = "S3 must be limited to the stack's buckets."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "StackRepositoriesOnly" && try(s.Resource, "") == "arn:aws:ecr:*:111111111111:repository/regulait-rehearsal*"]) == 1
    error_message = "ECR repository management must be limited to the stack's prefix."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "CreateRootResourcesWithScopeTagOnly" && try(s.Condition.StringNotEquals["aws:RequestTag/purpose"], null) == "rehearsal"]) == 1
    error_message = "Root resources must carry the scope tag to be created."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "DeleteRootResourcesWithScopeTagOnly"]) == 1
    error_message = "Root resources without the scope tag must not be deletable."
  }
}

run "no_scope_tag_drops_the_tag_checks" {
  command = plan

  variables {
    scope_tag = null
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.deployer.json).Statement : s if s.Sid == "CreateRootResourcesWithScopeTagOnly"]) == 0
    error_message = "scope_tag = null turns the tag checks off."
  }
}
