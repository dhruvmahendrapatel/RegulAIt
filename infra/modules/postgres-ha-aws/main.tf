# PostgreSQL on RDS with high availability (ADR-0343): a synchronous Multi-AZ
# standby with automatic failover, automated backups with point-in-time
# recovery, encryption with the caller's key, TLS required, no public endpoint,
# reachable on 5432 only from the security groups the caller names. The master
# password is generated and kept by RDS in Secrets Manager; it never appears in
# Terraform state or in a variable.
#
# Applications connect to `endpoint`, the writer's DNS name. RDS repoints it at
# the promoted standby on failover, so a client only has to reconnect.

resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  description = "PostgreSQL from the named security groups only."
  vpc_id      = var.vpc_id
  tags        = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "7.2.2"

  identifier                     = var.name
  instance_use_identifier_prefix = false

  engine               = "postgres"
  engine_version       = var.engine_version
  family               = "postgres${split(".", var.engine_version)[0]}"
  major_engine_version = split(".", var.engine_version)[0]
  instance_class       = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.allocated_storage_gb * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.database_name
  username = var.master_username
  port     = 5432

  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  multi_az               = var.multi_az
  create_db_subnet_group = true
  db_subnet_group_name   = var.name
  subnet_ids             = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  iam_database_authentication_enabled = true
  ca_cert_identifier                  = "rds-ca-rsa2048-g1"

  backup_retention_period          = var.backup_retention_days
  backup_window                    = "03:00-04:00"
  maintenance_window               = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot            = true
  delete_automated_backups         = var.skip_final_snapshot
  skip_final_snapshot              = var.skip_final_snapshot
  final_snapshot_identifier_prefix = "${var.name}-final"
  deletion_protection              = var.deletion_protection

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  performance_insights_enabled    = true
  performance_insights_kms_key_id = var.kms_key_arn

  enabled_cloudwatch_logs_exports        = ["postgresql"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = var.log_retention_days
  cloudwatch_log_group_kms_key_id        = var.kms_key_arn

  create_monitoring_role               = true
  monitoring_interval                  = 60
  monitoring_role_name                 = "${var.name}-rds-monitoring"
  monitoring_role_use_name_prefix      = true
  monitoring_role_permissions_boundary = var.iam_permissions_boundary_arn

  create_db_parameter_group       = true
  parameter_group_name            = var.name
  parameter_group_use_name_prefix = true
  parameters = [
    { name = "rds.force_ssl", value = "1" },
    # RPO 0 needs a commit to wait for the standby; `on` is the RDS default,
    # pinned here so a parameter-group change cannot weaken it silently.
    { name = "synchronous_commit", value = "on" },
    { name = "log_connections", value = "1" },
    { name = "log_disconnections", value = "1" },
  ]

  create_db_option_group       = true
  option_group_name            = var.name
  option_group_use_name_prefix = true
  option_group_description     = "${var.name} PostgreSQL option group"

  tags = var.tags
}
