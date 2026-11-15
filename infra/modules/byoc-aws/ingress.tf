# Optional AWS Load Balancer Controller identity (EKS Pod Identity) for an
# internal ALB in front of the gateway. The controller is installed from its
# official Helm chart (eks-charts, Apache-2.0) by the runbook; this file gives
# it exactly the upstream v3.6.3 IAM policy, carried verbatim in files/ so it
# is pinned and reviewable. The runbook turns WAF, Shield and Cognito off;
# those calls are outside the installer boundary anyway.

resource "aws_iam_role" "lb_controller" {
  count                = var.ingress_controller ? 1 : 0
  name                 = "${var.name_prefix}-lb-controller"
  assume_role_policy   = data.aws_iam_policy_document.pod_identity_trust.json
  permissions_boundary = var.iam_permissions_boundary_arn
  tags                 = var.tags
}

resource "aws_iam_policy" "lb_controller" {
  count       = var.ingress_controller ? 1 : 0
  name        = "${var.name_prefix}-lb-controller"
  description = "AWS Load Balancer Controller v3.6.3 (upstream docs/install/iam_policy.json)."
  policy      = file("${path.module}/files/aws-load-balancer-controller-v3.6.3-iam-policy.json")
  tags        = var.tags
}

resource "aws_iam_role_policy_attachment" "lb_controller" {
  count      = var.ingress_controller ? 1 : 0
  role       = aws_iam_role.lb_controller[0].name
  policy_arn = aws_iam_policy.lb_controller[0].arn
}

resource "aws_eks_pod_identity_association" "lb_controller" {
  count           = var.ingress_controller ? 1 : 0
  cluster_name    = module.eks.cluster_name
  namespace       = "kube-system"
  service_account = "aws-load-balancer-controller"
  role_arn        = aws_iam_role.lb_controller[0].arn
  tags            = var.tags
}

locals {
  ingress_inbound_cidrs = length(var.ingress_allowed_cidrs) > 0 ? var.ingress_allowed_cidrs : [var.vpc_cidr]
}
