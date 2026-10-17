# RegulAIt cloud AI discovery: read-only role for one AWS account (ADR-0195 decisions 16-17).
# You apply this in YOUR account; RegulAIt never creates IAM.
#
# STATUS: pending execution (M-041). Not yet run through `terraform validate` or applied to a real account.
#
# Federated (default): RegulAIt's ADR-0188 issuer is registered as an IAM OIDC provider and the role trusts tokens
# whose subject is this one discovery source. Set var.regulait_principal_arn and var.external_id instead to use
# AssumeRole with the external id RegulAIt generated for the source.

variable "regulait_issuer_url" {
  description = "RegulAIt workload identity issuer URL (https://...), shown on the discovery source page"
  type        = string
}

variable "regulait_source_id" {
  description = "The discovery source id; the token subject is regulait:discovery-source:<id>"
  type        = string
}

variable "regulait_principal_arn" {
  description = "Optional: an existing RegulAIt AWS principal for AssumeRole (leave empty for federation)"
  type        = string
  default     = ""
}

variable "external_id" {
  description = "Optional: the external id RegulAIt generated for this source (AssumeRole only)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "trail_bucket_arn" {
  description = "Optional: the CloudTrail bucket ARN, to read Bedrock data events"
  type        = string
  default     = ""
}

data "aws_caller_identity" "current" {}

locals {
  issuer_host = trimprefix(var.regulait_issuer_url, "https://")
  federated   = var.regulait_principal_arn == ""
}

resource "aws_iam_openid_connect_provider" "regulait" {
  count          = local.federated ? 1 : 0
  url            = var.regulait_issuer_url
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust" {
  dynamic "statement" {
    for_each = local.federated ? [1] : []
    content {
      actions = ["sts:AssumeRoleWithWebIdentity"]
      principals {
        type        = "Federated"
        identifiers = [aws_iam_openid_connect_provider.regulait[0].arn]
      }
      condition {
        test     = "StringEquals"
        variable = "${local.issuer_host}:aud"
        values   = ["sts.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "${local.issuer_host}:sub"
        values   = ["regulait:discovery-source:${var.regulait_source_id}"]
      }
    }
  }
  dynamic "statement" {
    for_each = local.federated ? [] : [1]
    content {
      actions = ["sts:AssumeRole"]
      principals {
        type        = "AWS"
        identifiers = [var.regulait_principal_arn]
      }
      condition {
        test     = "StringEquals"
        variable = "sts:ExternalId"
        values   = [var.external_id]
      }
    }
  }
}

data "aws_iam_policy_document" "read" {
  statement {
    sid = "AiInventory"
    actions = [
      "account:ListRegions",
      "bedrock:ListCustomModels",
      "bedrock:ListImportedModels",
      "bedrock:ListProvisionedModelThroughputs",
      "bedrock:ListGuardrails",
      "bedrock:GetModelInvocationLoggingConfiguration",
      "bedrock:ListAgents",
      "bedrock:ListKnowledgeBases",
      "sagemaker:ListEndpoints",
      "sagemaker:ListModels",
      "cloudtrail:LookupEvents",
    ]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.trail_bucket_arn == "" ? [] : [1]
    content {
      sid       = "TrailBucketList"
      actions   = ["s3:ListBucket"]
      resources = [var.trail_bucket_arn]
      condition {
        test     = "StringLike"
        variable = "s3:prefix"
        values   = ["AWSLogs/${data.aws_caller_identity.current.account_id}/CloudTrail/*", "*AWSLogs/${data.aws_caller_identity.current.account_id}/CloudTrail/*"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.trail_bucket_arn == "" ? [] : [1]
    content {
      sid       = "TrailBucketRead"
      actions   = ["s3:GetObject"]
      resources = ["${var.trail_bucket_arn}/*AWSLogs/${data.aws_caller_identity.current.account_id}/CloudTrail/*"]
    }
  }
}

resource "aws_iam_role" "regulait_discovery" {
  name                 = "regulait-ai-discovery"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "regulait_discovery_read" {
  name   = "regulait-ai-discovery-read"
  role   = aws_iam_role.regulait_discovery.id
  policy = data.aws_iam_policy_document.read.json
}

output "role_arn" {
  value = aws_iam_role.regulait_discovery.arn
}
