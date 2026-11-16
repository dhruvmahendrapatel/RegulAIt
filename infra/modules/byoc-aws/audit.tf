# Audit anchors: an S3 Object Lock bucket (infra/modules/audit-anchor-worm-s3).
# The gateway writes each audit-chain head here with a lock it cannot shorten
# or delete; in COMPLIANCE mode no one in the account can either.

module "audit_anchors" {
  source = "../audit-anchor-worm-s3"

  name              = "${var.name_prefix}-audit-anchor-writer"
  bucket_name       = "${var.name_prefix}-audit-anchors-${local.account}"
  object_lock_mode  = var.audit_object_lock_mode
  retention_days    = var.audit_retention_days
  kms_key_arn       = module.kms.key_arn
  writer_role_names = [module.gateway_pod_identity.iam_role_name]
  tags              = var.tags
}
