data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${local.region}.s3"
}

output "region" {
  value = local.region
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "kubeconfig_command" {
  description = "Run this to point kubectl at the cluster."
  value       = "aws eks update-kubeconfig --region ${local.region} --name ${module.eks.cluster_name}"
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "db_endpoint" {
  value = module.db.db_instance_address
}

output "db_port" {
  value = module.db.db_instance_port
}

output "db_name" {
  value = "regulait"
}

output "db_master_secret_arn" {
  description = "Secrets Manager secret holding the database master username and password (managed and encrypted by RDS)."
  value       = module.db.db_instance_master_user_secret_arn
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "audit_bucket" {
  value = module.audit_anchors.bucket
}

output "audit_object_lock_mode" {
  value = module.audit_anchors.object_lock_mode
}

output "gateway_role_arn" {
  value = aws_iam_role.gateway.arn
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.images : k => r.repository_url }
}

output "ecr_public_cache_prefix" {
  description = "Pull a public.ecr.aws image as <registry>/<this>/<path>, e.g. .../docker/library/postgres:16."
  value       = var.ecr_pull_through_ecr_public ? "${local.account}.dkr.ecr.${local.region}.amazonaws.com/${aws_ecr_pull_through_cache_rule.ecr_public[0].ecr_repository_prefix}" : null
}

output "egress" {
  description = "The internet path workloads have."
  value = {
    mode            = var.egress_mode
    allowed_domains = local.allow_list ? local.firewall_domains : []
    nat_public_ips  = aws_eip.nat[*].public_ip
  }
}

output "storage_class_manifest" {
  description = "kubectl apply -f - this StorageClass, then set installSecrets.storageClassName to its name."
  value = yamlencode({
    apiVersion           = "storage.k8s.io/v1"
    kind                 = "StorageClass"
    metadata             = { name = "${var.name_prefix}-encrypted-gp3" }
    provisioner          = "ebs.csi.aws.com"
    reclaimPolicy        = "Retain"
    volumeBindingMode    = "WaitForFirstConsumer"
    allowVolumeExpansion = true
    parameters = {
      type      = "gp3"
      encrypted = "true"
      kmsKeyId  = aws_kms_key.data.arn
    }
  })
}

output "helm_values" {
  description = "Values for deploy/helm/regulait derived from this stack. Merge with the image digest, version, Secret and bundle names (runbook step 6)."
  value = yamlencode({
    mode = "byoc"
    egress = {
      databaseCIDRs = local.database_subnets
      # Pods may open 443 to public addresses; the VPC firewall then allows
      # only egress_allowed_domains (allow_list) or nothing (none).
      allowPublicEgress = local.allow_list
      # VPC endpoints, plus S3's public ranges (the S3 gateway endpoint) when
      # there is no public egress to cover them.
      allowedCIDRs = local.allow_list ? local.endpoint_subnets : concat(local.endpoint_subnets, data.aws_ec2_managed_prefix_list.s3.entries[*].cidr)
    }
    installSecrets = {
      storageClassName = "${var.name_prefix}-encrypted-gp3"
    }
  })
}

output "gateway_environment" {
  description = "Gateway environment for this stack (S3 audit anchors through Pod Identity; no access key)."
  value = {
    AWS_REGION                              = local.region
    REGULAIT_AUDIT_ANCHOR_S3_BUCKET         = module.audit_anchors.bucket
    REGULAIT_AUDIT_ANCHOR_S3_PREFIX         = module.audit_anchors.prefix
    REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS = tostring(var.audit_retention_days)
  }
}

output "data_boundary" {
  description = "What this stack keeps in your account and what, if anything, leaves it."
  value       = <<-EOT
    Control plane and agent-execution plane: BOTH run in this account (EKS
    cluster ${module.eks.cluster_name}, region ${local.region}). Every prompt,
    completion, connector payload, audit row and key stays here: RDS
    ${module.db.db_instance_identifier}, audit bucket ${module.audit_anchors.bucket},
    KMS key ${aws_kms_key.data.arn}.
    To RegulAIt (the vendor): nothing. The product has no telemetry, licence
    check or update call (docs/deployment/DATA_BOUNDARY.md section 1), and this
    stack opens no path to a RegulAIt endpoint. Updates arrive as signed bundles
    you mirror into ${aws_ecr_repository.images["gateway"].repository_url}.
    Model calls: Amazon Bedrock in this account through a VPC endpoint
    (${length(var.bedrock_model_ids)} model(s) allowed).
    Internet: ${local.allow_list ? "HTTPS to ${join(", ", local.firewall_domains)} only, through Network Firewall, logged" : "none"}.
  EOT
}

output "lb_controller_helm_values" {
  description = "Values for the aws-load-balancer-controller chart (eks-charts) when ingress_controller is on."
  value = var.ingress_controller ? yamlencode({
    clusterName  = module.eks.cluster_name
    region       = local.region
    vpcId        = module.vpc.vpc_id
    enableShield = false
    enableWaf    = false
    enableWafv2  = false
    serviceAccount = {
      create = true
      name   = "aws-load-balancer-controller"
    }
  }) : null
}

output "ingress_manifest" {
  description = "An internal ALB Ingress for the gateway Service (<release>-gateway:3000). kubectl apply -n <namespace> -f - once the controller is running."
  value = var.ingress_controller && var.ingress_hostname != null && var.ingress_certificate_arn != null ? yamlencode({
    apiVersion = "networking.k8s.io/v1"
    kind       = "Ingress"
    metadata = {
      name = "regulait"
      annotations = {
        "alb.ingress.kubernetes.io/scheme"           = "internal"
        "alb.ingress.kubernetes.io/target-type"      = "ip"
        "alb.ingress.kubernetes.io/listen-ports"     = "[{\"HTTPS\":443}]"
        "alb.ingress.kubernetes.io/certificate-arn"  = var.ingress_certificate_arn
        "alb.ingress.kubernetes.io/ssl-policy"       = "ELBSecurityPolicy-TLS13-1-2-2021-06"
        "alb.ingress.kubernetes.io/inbound-cidrs"    = join(",", local.ingress_inbound_cidrs)
        "alb.ingress.kubernetes.io/healthcheck-path" = "/health"
        "alb.ingress.kubernetes.io/subnets"          = join(",", local.node_subnet_ids)
      }
    }
    spec = {
      ingressClassName = "alb"
      rules = [{
        host = var.ingress_hostname
        http = {
          paths = [{
            path     = "/"
            pathType = "Prefix"
            backend  = { service = { name = var.gateway_service_account, port = { number = 3000 } } }
          }]
        }
      }]
    }
  }) : null
}
