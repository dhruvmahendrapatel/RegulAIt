# PostgreSQL on RDS: encrypted with the stack key, TLS required, private
# subnets with no route out, reachable on 5432 from the EKS nodes only.
# Automated backups (point-in-time restore) for db_backup_retention_days, copied
# tags on snapshots, a final snapshot on delete, deletion protection on.
# The master password is generated and kept by RDS in Secrets Manager (encrypted
# with the stack key); it never appears in Terraform state or in a variable.
#
# The definition lives in ../postgres-ha-aws (ADR-0343 §4), shared with every
# other AWS install, so a hardening change is made once. This file only passes
# the stack's network, key and names. The names, descriptions and subnet group
# are the ones this stack used before the move, so an existing stack plans no
# replacement; its parameter group gains one pinned value
# (synchronous_commit = on, already the RDS default), an in-place change.

module "pg" {
  source = "../postgres-ha-aws"

  name                       = "${var.name_prefix}-pg"
  resource_name_prefix       = var.name_prefix
  security_group_description = "PostgreSQL from the EKS nodes only."
  ingress_description        = "PostgreSQL from EKS nodes and pods"

  vpc_id                     = module.vpc.vpc_id
  db_subnet_group_name       = module.vpc.database_subnet_group_name
  allowed_security_group_ids = [module.eks.node_security_group_id]
  kms_key_arn                = module.kms.key_arn

  engine_version       = var.db_engine_version
  instance_class       = var.db_instance_class
  allocated_storage_gb = var.db_allocated_storage_gb
  database_name        = "regulait"
  master_username      = "regulait_admin"

  multi_az              = var.db_multi_az
  backup_retention_days = var.db_backup_retention_days
  deletion_protection   = var.db_deletion_protection
  skip_final_snapshot   = var.db_skip_final_snapshot

  log_retention_days           = var.log_retention_days
  iam_permissions_boundary_arn = var.iam_permissions_boundary_arn

  tags = var.tags
}

# The resources were defined here before ADR-0343; these keep existing state.
moved {
  from = module.db
  to   = module.pg.module.db
}

moved {
  from = aws_security_group.db
  to   = module.pg.aws_security_group.db
}

moved {
  from = aws_vpc_security_group_ingress_rule.db_from_nodes
  to   = module.pg.aws_vpc_security_group_ingress_rule.db[0]
}
