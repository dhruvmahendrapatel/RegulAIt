# Kubernetes: EKS with one managed node group in the private subnets.
#
# - API endpoint private by default; a public endpoint only for the CIDRs in
#   cluster_endpoint_public_access_cidrs (never 0.0.0.0/0).
# - Authentication by EKS access entries only (no aws-auth ConfigMap).
# - Kubernetes secrets envelope-encrypted with the stack's KMS key.
# - Control-plane logs (api, audit, authenticator) to CloudWatch, KMS-encrypted.
# - Workload AWS access through EKS Pod Identity, not node roles: nodes get
#   only what kubelet and the VPC CNI need. IMDS is limited to one hop so pods
#   cannot borrow the node role.

locals {
  admin_entries = {
    for i, arn in var.cluster_admin_principal_arns : "admin-${i}" => {
      principal_arn = arn
      policy_associations = {
        admin = {
          policy_arn = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = {
            type = "cluster"
          }
        }
      }
    }
  }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.29.0"

  name               = local.cluster_name
  kubernetes_version = var.kubernetes_version

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = local.node_subnet_ids
  control_plane_subnet_ids = local.node_subnet_ids

  endpoint_private_access      = true
  endpoint_public_access       = length(var.cluster_endpoint_public_access_cidrs) > 0
  endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs

  authentication_mode                      = "API"
  enable_cluster_creator_admin_permissions = true
  access_entries                           = local.admin_entries

  create_kms_key = false
  encryption_config = {
    provider_key_arn = aws_kms_key.data.arn
    resources        = ["secrets"]
  }
  attach_encryption_policy          = true
  encryption_policy_name            = "${var.name_prefix}-eks-encryption"
  encryption_policy_use_name_prefix = true

  enabled_log_types                      = ["api", "audit", "authenticator"]
  cloudwatch_log_group_retention_in_days = var.log_retention_days
  cloudwatch_log_group_kms_key_id        = aws_kms_key.data.arn

  enable_irsa = false

  iam_role_name                 = "${var.name_prefix}-eks-cluster"
  iam_role_use_name_prefix      = true
  iam_role_permissions_boundary = var.iam_permissions_boundary_arn

  # EKS Auto Mode is not used, so the module's Auto Mode node role is not made.
  create_node_iam_role = false

  security_group_name      = "${var.name_prefix}-eks-cluster"
  node_security_group_name = "${var.name_prefix}-eks-node"

  addons = {
    vpc-cni = {
      before_compute = true
      # EKS does not enforce NetworkPolicy unless the VPC CNI is told to; the
      # chart's default-deny policies would otherwise be decoration.
      configuration_values = jsonencode({ enableNetworkPolicy = "true" })
    }
    kube-proxy = {}
    coredns    = {}
    eks-pod-identity-agent = {
      before_compute = true
    }
    # The chart's install-secrets volume is a PVC: it needs the EBS CSI driver
    # and a StorageClass encrypted with the stack key (see outputs).
    aws-ebs-csi-driver = {
      pod_identity_association = [{
        role_arn        = aws_iam_role.ebs_csi.arn
        service_account = "ebs-csi-controller-sa"
      }]
    }
  }

  eks_managed_node_groups = {
    default = {
      name            = "${var.name_prefix}-ng"
      use_name_prefix = true
      ami_type        = "AL2023_x86_64_STANDARD"
      instance_types  = var.node_instance_types
      min_size        = var.node_count
      desired_size    = var.node_count
      max_size        = var.node_count + 1
      subnet_ids      = local.node_subnet_ids

      iam_role_name                 = "${var.name_prefix}-eks-ng"
      iam_role_use_name_prefix      = true
      iam_role_permissions_boundary = var.iam_permissions_boundary_arn

      # First pull through the public.ecr.aws cache creates the cached
      # repository, which needs these two calls on the cache prefix only.
      create_iam_role_policy = var.ecr_pull_through_ecr_public
      iam_role_policy_statements = var.ecr_pull_through_ecr_public ? [{
        sid       = "PullThroughCacheFirstPull"
        actions   = ["ecr:CreateRepository", "ecr:BatchImportUpstreamImage"]
        resources = ["arn:${local.partition}:ecr:${local.region}:${local.account}:repository/${var.name_prefix}-ecr-public/*"]
      }] : []

      launch_template_name            = "${var.name_prefix}-ng"
      launch_template_use_name_prefix = true

      metadata_options = {
        http_endpoint               = "enabled"
        http_tokens                 = "required"
        http_put_response_hop_limit = 1
      }

      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size = 50
            volume_type = "gp3"
            # Node root volumes hold no product data (the install-secrets
            # volume is a PVC on the stack key, below), so the AWS-managed EBS
            # key is used: a customer key here needs a grant for the Auto
            # Scaling service-linked role, which may not exist yet.
            encrypted             = true
            delete_on_termination = true
          }
        }
      }
    }
  }

  tags = var.tags
}

### EBS CSI driver identity (Pod Identity) ###

data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name                 = "${var.name_prefix}-ebs-csi"
  assume_role_policy   = data.aws_iam_policy_document.pod_identity_trust.json
  permissions_boundary = var.iam_permissions_boundary_arn
  tags                 = var.tags
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

data "aws_iam_policy_document" "ebs_csi_kms" {
  statement {
    actions   = ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
  statement {
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ec2.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ebs_csi_kms" {
  name   = "stack-key-for-volumes"
  role   = aws_iam_role.ebs_csi.id
  policy = data.aws_iam_policy_document.ebs_csi_kms.json
}
