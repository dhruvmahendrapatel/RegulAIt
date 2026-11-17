# Offline plan-only tests (mocked google provider). No Google Cloud call is made.

mock_provider "google" {}

variables {
  name             = "app-pg"
  project_id       = "app-project"
  region           = "europe-west1"
  private_network  = "projects/app-project/global/networks/app"
  kms_key_name     = "projects/app-project/locations/europe-west1/keyRings/app/cryptoKeys/pg"
  root_password_wo = "not-a-real-password-test-only"
}

run "secure_ha_defaults" {
  command = plan

  assert {
    condition     = google_sql_database_instance.primary.settings[0].availability_type == "REGIONAL" && google_sql_database_instance.primary.deletion_protection && google_sql_database_instance.primary.settings[0].deletion_protection_enabled
    error_message = "A regional (synchronous standby) instance with both deletion guards is the default."
  }

  assert {
    condition     = google_sql_database_instance.primary.settings[0].backup_configuration[0].point_in_time_recovery_enabled && google_sql_database_instance.primary.settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups >= 7
    error_message = "Point-in-time recovery and a week or more of backups are the defaults."
  }

  assert {
    condition     = !google_sql_database_instance.primary.settings[0].ip_configuration[0].ipv4_enabled && google_sql_database_instance.primary.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "Private IP only, and TLS required."
  }

  assert {
    condition     = contains([for f in google_sql_database_instance.primary.settings[0].database_flags : "${f.name}=${f.value}"], "synchronous_commit=on")
    error_message = "Synchronous commit is pinned."
  }

  assert {
    condition     = length(google_sql_database_instance.dr_replica) == 0
    error_message = "No cross-region replica unless asked for."
  }
}

run "dr_replica_in_another_region" {
  command = plan

  variables {
    dr_replica = {
      region       = "europe-west4"
      kms_key_name = "projects/app-project/locations/europe-west4/keyRings/app/cryptoKeys/pg"
    }
  }

  assert {
    condition     = google_sql_database_instance.dr_replica[0].region == "europe-west4" && google_sql_database_instance.dr_replica[0].master_instance_name == "app-pg"
    error_message = "The replica follows the primary from another region."
  }
}

run "shared_core_tier_is_refused" {
  command = plan

  variables {
    tier = "db-f1-micro"
  }

  expect_failures = [var.tier]
}

run "a_short_key_name_is_refused" {
  command = plan

  variables {
    kms_key_name = "pg"
  }

  expect_failures = [var.kms_key_name]
}
