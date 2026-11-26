# Operator backups to S3 in this account (ADR-0305 §2). The RegulAIt
# operator's backup CronJob runs pg_dump and uploads the dump here with SSE-KMS
# under the stack key. This file gives it a bucket and an identity, and
# nothing more:
#   - the bucket comes from infra/modules/backup-target-s3: versioned, TLS-only,
#     public access blocked, ACLs off, lifecycle expiry, never force-deleted,
#     and an explicit Deny of every destructive action for the writer;
#   - the grant is that module's "kubernetes_job" profile: s3:PutObject on the
#     prefix, and kms:GenerateDataKey and kms:Decrypt on the stack key, both
#     only via S3 in this region and only for this bucket. No GetObject, no
#     ListBucket, no Delete: a compromised backup pod cannot read or destroy
#     earlier backups;
#   - the identity is EKS Pod Identity (terraform-aws-modules/eks-pod-identity,
#     ADR-0176), bound to the one ServiceAccount the operator creates,
#     <installation>-backup in the installation namespace. The gateway never
#     holds this role.

locals {
  backup_service_account = "${var.backup_installation_name}-backup"
}

module "backup_pod_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "2.10.0"
  create  = var.operator_backups

  name                     = "${var.name_prefix}-operator-backup"
  use_name_prefix          = false
  description              = "RegulAIt operator backup Job (${var.gateway_namespace}/${local.backup_service_account}) via EKS Pod Identity: write-only to the backup bucket."
  permissions_boundary_arn = var.iam_permissions_boundary_arn
  trust_policy_conditions  = local.pod_identity_trust_conditions

  additional_policy_arns = var.operator_backups ? { backup = module.backup_target[0].writer_policy_arn } : {}

  associations = {
    backup = {
      cluster_name    = module.eks.cluster_name
      namespace       = var.gateway_namespace
      service_account = local.backup_service_account
    }
  }

  tags = var.tags
}

module "backup_target" {
  source = "../backup-target-s3"
  count  = var.operator_backups ? 1 : 0

  name           = "${var.name_prefix}-operator"
  bucket_name    = "${var.name_prefix}-backups-${local.account}"
  prefix         = "pg"
  kms_key_arn    = module.kms.key_arn
  writer_profile = "kubernetes_job"

  # The Pod Identity module attaches the policy; this module names the role in
  # the bucket policy's explicit Deny.
  writer_role_arns = [module.backup_pod_identity.iam_role_arn]

  retention_days                    = var.backup_retention_days
  noncurrent_version_retention_days = var.backup_noncurrent_version_retention_days

  # The Job publishes no heartbeat metric, so a freshness alarm would always
  # read as failure. The operator reports each run on the installation's
  # BackupConfigured condition and the CronJob's status instead (ADR-0305).
  enable_freshness_alarm = false

  tags = var.tags
}
