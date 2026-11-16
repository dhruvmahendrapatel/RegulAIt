# The gateway's AWS identity, by EKS Pod Identity: bound to one namespace and
# one service account. It may invoke the listed Bedrock models and write audit
# anchors (granted by the audit module). Nothing else: no database password
# (that is a Kubernetes Secret), no S3 beyond the anchor prefix.
# Built with terraform-aws-modules/eks-pod-identity (ADR-0176), like every
# Pod Identity role in this stack.

locals {
  # A cross-region inference profile ("us.<model>") routes to the base model
  # in several regions, so the base model is granted in any region, but only
  # through a profile in this account or directly in this region.
  bedrock_base_ids = [for id in var.bedrock_model_ids : replace(id, "/^(us|eu|apac|us-gov|global)\\./", "")]
  bedrock_profiles = [for id in var.bedrock_model_ids : id if id != replace(id, "/^(us|eu|apac|us-gov|global)\\./", "")]
}

locals {
  bedrock_invoke_actions = [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:Converse",
    "bedrock:ConverseStream",
  ]

  gateway_policy_statements = concat(
    length(local.bedrock_base_ids) > 0 ? [{
      sid       = "InvokeListedModelsInThisRegion"
      actions   = local.bedrock_invoke_actions
      resources = [for id in local.bedrock_base_ids : "arn:${local.partition}:bedrock:${local.region}::foundation-model/${id}"]
    }] : [],
    length(local.bedrock_profiles) > 0 ? [{
      sid     = "InvokeListedInferenceProfiles"
      actions = local.bedrock_invoke_actions
      resources = concat(
        [for id in local.bedrock_profiles : "arn:${local.partition}:bedrock:${local.region}:${local.account}:inference-profile/${id}"],
        [for id in local.bedrock_profiles : "arn:${local.partition}:bedrock:*::foundation-model/${replace(id, "/^(us|eu|apac|us-gov|global)\\./", "")}"],
      )
    }] : [],
  )
}

module "gateway_pod_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "2.10.0"

  name                     = "${var.name_prefix}-gateway"
  use_name_prefix          = false
  description              = "RegulAIt gateway (${var.gateway_namespace}/${var.gateway_service_account}) via EKS Pod Identity."
  permissions_boundary_arn = var.iam_permissions_boundary_arn
  trust_policy_conditions  = local.pod_identity_trust_conditions

  # No model is granted when bedrock_model_ids is empty.
  attach_custom_policy      = length(var.bedrock_model_ids) > 0
  custom_policy_description = "Invoke only the listed Bedrock models."
  policy_statements         = local.gateway_policy_statements

  associations = {
    gateway = {
      cluster_name    = module.eks.cluster_name
      namespace       = var.gateway_namespace
      service_account = var.gateway_service_account
    }
  }

  tags = var.tags
}
