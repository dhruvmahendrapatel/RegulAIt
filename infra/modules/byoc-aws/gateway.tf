# The gateway's AWS identity, by EKS Pod Identity: bound to one namespace and
# one service account. It may invoke the listed Bedrock models and write audit
# anchors (granted by the audit module). Nothing else: no database password
# (that is a Kubernetes Secret), no S3 beyond the anchor prefix.

resource "aws_iam_role" "gateway" {
  name                 = "${var.name_prefix}-gateway"
  description          = "RegulAIt gateway (${var.gateway_namespace}/${var.gateway_service_account}) via EKS Pod Identity."
  assume_role_policy   = data.aws_iam_policy_document.pod_identity_trust.json
  permissions_boundary = var.iam_permissions_boundary_arn
  tags                 = var.tags
}

resource "aws_eks_pod_identity_association" "gateway" {
  cluster_name    = module.eks.cluster_name
  namespace       = var.gateway_namespace
  service_account = var.gateway_service_account
  role_arn        = aws_iam_role.gateway.arn
  tags            = var.tags
}

locals {
  # A cross-region inference profile ("us.<model>") routes to the base model
  # in several regions, so the base model is granted in any region, but only
  # through a profile in this account or directly in this region.
  bedrock_base_ids = [for id in var.bedrock_model_ids : replace(id, "/^(us|eu|apac|us-gov|global)\\./", "")]
  bedrock_profiles = [for id in var.bedrock_model_ids : id if id != replace(id, "/^(us|eu|apac|us-gov|global)\\./", "")]
}

data "aws_iam_policy_document" "gateway_bedrock" {
  count = length(var.bedrock_model_ids) > 0 ? 1 : 0

  statement {
    sid = "InvokeListedModelsInThisRegion"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
    ]
    resources = [for id in local.bedrock_base_ids : "arn:${local.partition}:bedrock:${local.region}::foundation-model/${id}"]
  }

  dynamic "statement" {
    for_each = length(local.bedrock_profiles) > 0 ? [1] : []
    content {
      sid = "InvokeListedInferenceProfiles"
      actions = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:Converse",
        "bedrock:ConverseStream",
      ]
      resources = concat(
        [for id in local.bedrock_profiles : "arn:${local.partition}:bedrock:${local.region}:${local.account}:inference-profile/${id}"],
        [for id in local.bedrock_profiles : "arn:${local.partition}:bedrock:*::foundation-model/${replace(id, "/^(us|eu|apac|us-gov|global)\\./", "")}"],
      )
    }
  }
}

resource "aws_iam_role_policy" "gateway_bedrock" {
  count  = length(var.bedrock_model_ids) > 0 ? 1 : 0
  name   = "bedrock-listed-models"
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.gateway_bedrock[0].json
}
