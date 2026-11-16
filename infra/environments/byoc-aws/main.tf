# RegulAIt BYOC on AWS: the root you apply (ADR-0325). Every input is
# described in infra/modules/byoc-aws/variables.tf; the install runbook is
# docs/deployment/BYOC_AWS_INSTALL.md.

module "byoc" {
  source = "../../modules/byoc-aws"

  name_prefix                          = var.name_prefix
  tags                                 = var.tags
  vpc_cidr                             = var.vpc_cidr
  az_count                             = var.az_count
  egress_mode                          = var.egress_mode
  egress_allowed_domains               = var.egress_allowed_domains
  log_retention_days                   = var.log_retention_days
  kubernetes_version                   = var.kubernetes_version
  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs
  cluster_admin_principal_arns         = var.cluster_admin_principal_arns
  node_instance_types                  = var.node_instance_types
  node_count                           = var.node_count
  db_instance_class                    = var.db_instance_class
  db_multi_az                          = var.db_multi_az
  db_backup_retention_days             = var.db_backup_retention_days
  firewall_delete_protection           = var.firewall_delete_protection
  db_deletion_protection               = var.db_deletion_protection
  db_skip_final_snapshot               = var.db_skip_final_snapshot
  audit_object_lock_mode               = var.audit_object_lock_mode
  audit_retention_days                 = var.audit_retention_days
  bedrock_model_ids                    = var.bedrock_model_ids
  iam_permissions_boundary_arn         = var.iam_permissions_boundary_arn
  ingress_controller                   = var.ingress_controller
  ingress_allowed_cidrs                = var.ingress_allowed_cidrs
  ingress_hostname                     = var.ingress_hostname
  ingress_certificate_arn              = var.ingress_certificate_arn
}
