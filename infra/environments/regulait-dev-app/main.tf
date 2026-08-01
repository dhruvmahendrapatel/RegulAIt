# regulait-dev-app — the RegulAIt gateway itself, running as a dev/demo stack
# in the workload account. Deliberately separate state from regulait-dev (the
# org/security baseline) so an app deploy can never re-plan the foundation.
#
# NOT production. Single instance, demo seed data. Standing guardrail applies:
# any production designation needs explicit user sign-off.
#
# TLS (ADR-0029): an in-compose Caddy reverse proxy terminates HTTPS with a real
# Let's Encrypt certificate for `<dashed-public-ip>.sslip.io`. Only 80 and 443
# are open; the app's own 3000 is bound to host loopback and is no longer an
# ingress port at all. Zero added AWS cost — no ALB, no ACM, no Route53.

locals {
  tags = {
    Project     = "RegulAIt"
    Environment = "dev"
    ManagedBy   = "terraform"
    Stack       = "regulait-dev-app"
  }
}

module "app" {
  source = "../../modules/app-instance"

  name          = "regulait-dev-app"
  app_port      = 3000 # loopback-only now; Caddy proxies to it over the compose network
  ingress_ports = [80, 443]
  # 80 is not optional: Let's Encrypt's HTTP-01 challenge and every subsequent
  # renewal are served there. Closing it breaks issuance ~60 days later, quietly.
  enable_onbox_tls = true

  # Pinned to the image the box is ALREADY running (verified 2026-08-01 via
  # ec2 describe-instances). Without this the SSM "latest" lookup drifts and
  # plan proposes replacing the instance — which would destroy the Postgres
  # container volume. Change only with a data-migration plan.
  ami_id             = "ami-0b8dddb344dc74379"
  instance_type      = var.instance_type
  ingress_cidrs      = var.ingress_cidrs
  source_bucket_name = "regulait-dev-app-source-517506432475"

  # PREREQUISITE for the power schedule below, not an optional nicety. The
  # instance's auto-assigned public IPv4 is released on every stop and a new one
  # is issued on the next start — and this stack's entire public identity is
  # derived from that address (`<dashed-ip>.sslip.io`, ADR-0029), so a nightly
  # power cycle would change the URL, invalidate the Let's Encrypt certificate,
  # and force a fresh ACME issuance every morning. An Elastic IP pins it.
  # Cost detail and the one-time IP cutover are in ADR-0032.
  assign_elastic_ip = var.assign_elastic_ip

  tags = local.tags
}

# --- scheduled power (ADR-0032) ----------------------------------------------
#
# The dev box is a single t3.small that nobody uses overnight or at weekends.
# Powering it off outside a weekday window roughly halves the monthly bill for
# this stack. StopInstances is a graceful shutdown that PRESERVES the EBS root
# volume, which is where the Postgres container volume lives — this is a
# stop/start, never a replace. See infra/modules/scheduled-power/README.md.
module "power_schedule" {
  source = "../../modules/scheduled-power"

  name         = "regulait-dev-app"
  instance_ids = [module.app.instance_id]

  enabled    = var.power_schedule_enabled
  start_cron = var.power_schedule_start_cron
  stop_cron  = var.power_schedule_stop_cron
  timezone   = var.power_schedule_timezone

  tags = local.tags
}

# --- database backup (ADR-0035) ----------------------------------------------
#
# THE PROBLEM THIS CLOSES: the whole database is a Docker named volume
# (`pgdata`) on the root EBS volume of the single instance above. No RDS, no
# replica, no snapshot. Every user, credential ciphertext, audit row, project,
# workflow instance and spend record lives there and nowhere else — and ADR-0032
# now power-cycles that box every weekday on purpose. An audit log with no
# backup is not an audit log.
#
# This half is only the DESTINATION and the permission to write to it. The job
# itself is `infra/scripts/pg-backup.sh`, a self-installing systemd timer on the
# box — deliberately NOT user_data, because user_data runs once per INSTANCE and
# editing it makes the EC2 provider stop/start the box (and, before the Elastic
# IP, changed its address). See docs/ops/DB_BACKUP.md for the install command,
# which `backup_install_command` below prints ready to paste.
module "db_backup" {
  source = "../../modules/backup-target-s3"

  name        = "regulait-dev-app-db"
  bucket_name = "regulait-dev-app-db-backup-517506432475"
  prefix      = "postgres"

  # The box writes its own backups, so the grant lands on the instance role.
  # Attaching a policy to an existing role does not touch `aws_instance`.
  writer_role_names = [module.app.instance_role_name]

  retention_days                    = var.backup_retention_days
  noncurrent_version_retention_days = var.backup_noncurrent_retention_days

  enable_freshness_alarm = var.backup_alarm_enabled
  freshness_missing_days = var.backup_alarm_missing_days
  alarm_sns_topic_arns   = var.backup_alarm_sns_topic_arns
  metric_namespace       = "RegulAIt/Backup"

  # SSE-S3, not KMS. A customer-managed key costs $1/mo plus per-request charges
  # and, for a dev bucket whose only reader is this account's own admin, isolates
  # it from nobody. Revisit if a compliance tag (pillar 3) ever demands a key
  # whose grants we control.
  kms_key_arn = null

  tags = local.tags
}
