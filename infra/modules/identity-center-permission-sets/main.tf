data "aws_ssoadmin_instances" "this" {
  provider = aws.management
}

locals {
  sso_instance_arn  = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  identity_store_id = tolist(data.aws_ssoadmin_instances.this.identity_store_ids)[0]
}

### Admin-BreakGlass ###
# NOTE: the very first assignment of this permission set is created manually
# in the console (see CLAUDE.md Phase A / ADR-0004) to break the chicken-and-
# egg problem of needing an authenticated SSO session before Terraform can
# run at all. If this resource conflicts with that manual one on first apply,
# `terraform import` it rather than letting Terraform create a duplicate.

resource "aws_ssoadmin_permission_set" "admin_break_glass" {
  provider         = aws.management
  name             = "Admin-BreakGlass"
  description      = "Foundation/guardrail changes only. Rarely used."
  instance_arn     = local.sso_instance_arn
  session_duration = "PT1H"
}

resource "aws_ssoadmin_managed_policy_attachment" "admin_break_glass" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.admin_break_glass.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_ssoadmin_account_assignment" "admin_break_glass_workload" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.admin_break_glass.arn
  principal_id       = var.user_principal_id
  principal_type     = "USER"
  target_id          = var.workload_account_id
  target_type        = "AWS_ACCOUNT"
}

resource "aws_ssoadmin_account_assignment" "admin_break_glass_management" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.admin_break_glass.arn
  principal_id       = var.user_principal_id
  principal_type     = "USER"
  target_id          = var.management_account_id
  target_type        = "AWS_ACCOUNT"
}

### Deploy-Builder ###
# Base: PowerUserAccess (AWS-managed) already excludes IAM and Organizations
# management by design. Layered on top: an explicit inline deny for anything
# that could disable a guardrail or escalate privilege, plus a permissions
# boundary on any role this identity creates.

resource "aws_ssoadmin_permission_set" "deploy_builder" {
  provider         = aws.management
  name             = "Deploy-Builder"
  description      = "Day-to-day CLI/Terraform work — used by the human and the agent."
  instance_arn     = local.sso_instance_arn
  session_duration = "PT10H"
}

resource "aws_ssoadmin_managed_policy_attachment" "deploy_builder_poweruser" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.deploy_builder.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_ssoadmin_permission_set_inline_policy" "deploy_builder" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.deploy_builder.arn
  inline_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyOrgAndSsoAdmin"
        Effect = "Deny"
        Action = [
          "organizations:*",
          "sso:*",
          "sso-admin:*",
          "account:*"
        ]
        Resource = "*"
      },
      {
        Sid    = "DenyDisableGuardrails"
        Effect = "Deny"
        Action = [
          "cloudtrail:StopLogging",
          "cloudtrail:DeleteTrail",
          "guardduty:DeleteDetector",
          "securityhub:DisableSecurityHub",
          "config:DeleteConfigurationRecorder",
          "config:StopConfigurationRecorder",
          "s3:PutAccountPublicAccessBlock"
        ]
        Resource = "*"
      },
      {
        Sid      = "RequirePermissionsBoundaryOnRoleCreate"
        Effect   = "Deny"
        Action   = "iam:CreateRole"
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "iam:PermissionsBoundary" = var.deploy_builder_boundary_policy_arn
          }
        }
      }
    ]
  })
}

resource "aws_ssoadmin_permissions_boundary_attachment" "deploy_builder" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.deploy_builder.arn

  permissions_boundary {
    customer_managed_policy_reference {
      name = var.deploy_builder_boundary_policy_name
      path = "/"
    }
  }
}

resource "aws_ssoadmin_account_assignment" "deploy_builder" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.deploy_builder.arn
  principal_id       = var.user_principal_id
  principal_type     = "USER"
  target_id          = var.workload_account_id
  target_type        = "AWS_ACCOUNT"
}

### ReadOnly-Audit ###

resource "aws_ssoadmin_permission_set" "readonly_audit" {
  provider         = aws.management
  name             = "ReadOnly-Audit"
  description      = "Inspection, cost review, auditor access."
  instance_arn     = local.sso_instance_arn
  session_duration = "PT12H"
}

resource "aws_ssoadmin_managed_policy_attachment" "readonly_audit" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.readonly_audit.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_ssoadmin_account_assignment" "readonly_audit_workload" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.readonly_audit.arn
  principal_id       = var.user_principal_id
  principal_type     = "USER"
  target_id          = var.workload_account_id
  target_type        = "AWS_ACCOUNT"
}

resource "aws_ssoadmin_account_assignment" "readonly_audit_management" {
  provider           = aws.management
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.readonly_audit.arn
  principal_id       = var.user_principal_id
  principal_type     = "USER"
  target_id          = var.management_account_id
  target_type        = "AWS_ACCOUNT"
}
