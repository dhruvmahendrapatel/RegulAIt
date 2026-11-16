# Optional AWS Load Balancer Controller identity (EKS Pod Identity) for an
# internal ALB in front of the gateway. The controller is installed from its
# official Helm chart (eks-charts, Apache-2.0) by the runbook. Its IAM policy
# is the one terraform-aws-modules/eks-pod-identity maintains for the
# controller (ADR-0176), so it follows upstream releases instead of a copied
# file. The runbook turns WAF, Shield and Cognito off; those calls are outside
# the workload boundary anyway.

module "lb_controller_pod_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "2.10.0"
  create  = var.ingress_controller

  name                     = "${var.name_prefix}-lb-controller"
  use_name_prefix          = false
  permissions_boundary_arn = var.iam_permissions_boundary_arn
  trust_policy_conditions  = local.pod_identity_trust_conditions

  attach_aws_lb_controller_policy = true
  aws_lb_controller_policy_name   = "${var.name_prefix}-lb-controller"

  associations = {
    controller = {
      cluster_name    = module.eks.cluster_name
      namespace       = "kube-system"
      service_account = "aws-load-balancer-controller"
    }
  }

  tags = var.tags
}

locals {
  ingress_inbound_cidrs = length(var.ingress_allowed_cidrs) > 0 ? var.ingress_allowed_cidrs : [var.vpc_cidr]
}
