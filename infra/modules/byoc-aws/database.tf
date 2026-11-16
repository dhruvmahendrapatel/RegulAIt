# PostgreSQL on RDS: encrypted with the stack key, TLS required, private
# subnets with no route out, reachable on 5432 from the EKS nodes only.
# Automated backups (point-in-time restore) for db_backup_retention_days, copied
# tags on snapshots, a final snapshot on delete, deletion protection on.
# The master password is generated and kept by RDS in Secrets Manager (encrypted
# with the stack key); it never appears in Terraform state or in a variable.

resource "aws_security_group" "db" {
  name_prefix = "${var.name_prefix}-db-"
  description = "PostgreSQL from the EKS nodes only."
  vpc_id      = module.vpc.vpc_id
  tags        = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_nodes" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from EKS nodes and pods"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = module.eks.node_security_group_id
}

module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "7.2.2"

  identifier                     = "${var.name_prefix}-pg"
  instance_use_identifier_prefix = false

  engine               = "postgres"
  engine_version       = var.db_engine_version
  family               = "postgres${split(".", var.db_engine_version)[0]}"
  major_engine_version = split(".", var.db_engine_version)[0]
  instance_class       = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = module.kms.key_arn

  db_name  = "regulait"
  username = "regulait_admin"
  port     = 5432

  manage_master_user_password   = true
  master_user_secret_kms_key_id = module.kms.key_arn

  multi_az               = var.db_multi_az
  create_db_subnet_group = false
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  iam_database_authentication_enabled = true
  ca_cert_identifier                  = "rds-ca-rsa2048-g1"

  backup_retention_period          = var.db_backup_retention_days
  backup_window                    = "03:00-04:00"
  maintenance_window               = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot            = true
  delete_automated_backups         = var.db_skip_final_snapshot
  skip_final_snapshot              = var.db_skip_final_snapshot
  final_snapshot_identifier_prefix = "${var.name_prefix}-pg-final"
  deletion_protection              = var.db_deletion_protection

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  performance_insights_enabled    = true
  performance_insights_kms_key_id = module.kms.key_arn

  enabled_cloudwatch_logs_exports        = ["postgresql"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = var.log_retention_days
  cloudwatch_log_group_kms_key_id        = module.kms.key_arn

  create_monitoring_role               = true
  monitoring_interval                  = 60
  monitoring_role_name                 = "${var.name_prefix}-rds-monitoring"
  monitoring_role_use_name_prefix      = true
  monitoring_role_permissions_boundary = var.iam_permissions_boundary_arn

  create_db_parameter_group       = true
  parameter_group_name            = "${var.name_prefix}-pg"
  parameter_group_use_name_prefix = true
  parameters = [
    { name = "rds.force_ssl", value = "1" },
    { name = "log_connections", value = "1" },
    { name = "log_disconnections", value = "1" },
  ]

  # The stack's own (empty) option group: the default one is outside the
  # installer boundary's name guard.
  create_db_option_group       = true
  option_group_name            = "${var.name_prefix}-pg"
  option_group_use_name_prefix = true
  option_group_description     = "${var.name_prefix} PostgreSQL option group"

  tags = var.tags
}
