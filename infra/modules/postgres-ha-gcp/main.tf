# Cloud SQL for PostgreSQL with high availability (ADR-0343): a REGIONAL
# instance (a synchronous standby in a second zone with automatic failover),
# daily backups with point-in-time recovery, encryption with the caller's key,
# TLS required, a private IP only, deletion protection, and an optional
# cross-region replica for region loss.
#
# Applications connect to `private_ip_address` (or through the Cloud SQL
# connector with `connection_name`); both follow the primary through a zone
# failover, so a client only has to reconnect.

locals {
  flags = [
    { name = "cloudsql.iam_authentication", value = "on" },
    # RPO 0 needs a commit to wait for the standby's disk (`on` is the default)
    { name = "synchronous_commit", value = "on" },
    { name = "log_connections", value = "on" },
    { name = "log_disconnections", value = "on" },
  ]
}

resource "google_sql_database_instance" "primary" {
  name                = var.name
  project             = var.project_id
  region              = var.region
  database_version    = var.database_version
  encryption_key_name = var.kms_key_name
  deletion_protection = var.deletion_protection

  root_password_wo         = var.root_password_wo
  root_password_wo_version = var.root_password_version

  settings {
    tier                        = var.tier
    edition                     = "ENTERPRISE"
    availability_type           = var.availability_type
    disk_type                   = "PD_SSD"
    disk_size                   = var.disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection
    retain_backups_on_delete    = true
    user_labels                 = var.labels

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.backup_retention_count
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.private_network
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    dynamic "database_flags" {
      for_each = local.flags
      content {
        name  = database_flags.value.name
        value = database_flags.value.value
      }
    }

    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_client_address   = false
      record_application_tags = false
    }
  }
}

resource "google_sql_database_instance" "dr_replica" {
  count = var.dr_replica == null ? 0 : 1

  name                 = "${var.name}-dr"
  project              = var.project_id
  region               = var.dr_replica.region
  database_version     = var.database_version
  master_instance_name = google_sql_database_instance.primary.name
  encryption_key_name  = var.dr_replica.kms_key_name
  deletion_protection  = var.deletion_protection

  replica_configuration {
    failover_target = false
  }

  settings {
    tier                        = var.tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection
    user_labels                 = var.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.private_network
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    dynamic "database_flags" {
      for_each = local.flags
      content {
        name  = database_flags.value.name
        value = database_flags.value.value
      }
    }
  }
}
