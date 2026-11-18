# Offline plan-only tests (mocked azurerm provider). No Azure call is made.

mock_provider "azurerm" {}

variables {
  name                                 = "app-pg"
  resource_group_name                  = "rg-app"
  location                             = "westeurope"
  delegated_subnet_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers/Microsoft.Network/virtualNetworks/vnet/subnets/pg"
  private_dns_zone_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers/Microsoft.Network/privateDnsZones/app.postgres.database.azure.com"
  administrator_password_wo            = "not-a-real-password-test-only"
  entra_tenant_id                      = "00000000-0000-0000-0000-000000000001"
  user_assigned_identity_id            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pg"
  key_vault_key_id                     = "https://kv-app.vault.azure.net/keys/pg/0123456789abcdef0123456789abcdef"
  geo_backup_user_assigned_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app-dr/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pg-dr"
  geo_backup_key_vault_key_id          = "https://kv-app-dr.vault.azure.net/keys/pg/0123456789abcdef0123456789abcdef"
}

run "secure_ha_defaults" {
  command = plan

  assert {
    condition     = azurerm_postgresql_flexible_server.this.high_availability[0].mode == "ZoneRedundant" && azurerm_postgresql_flexible_server.this.high_availability[0].standby_availability_zone == "2"
    error_message = "A zone-redundant standby in a second zone is the default."
  }

  assert {
    condition     = !azurerm_postgresql_flexible_server.this.public_network_access_enabled && azurerm_postgresql_flexible_server.this.geo_redundant_backup_enabled && azurerm_postgresql_flexible_server.this.backup_retention_days >= 7
    error_message = "No public endpoint, geo-redundant backups and a week or more of PITR are the defaults."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server_configuration.require_tls.value == "ON" && azurerm_postgresql_flexible_server_configuration.tls_min.value == "TLSv1.2" && azurerm_postgresql_flexible_server_configuration.synchronous_commit.value == "on"
    error_message = "TLS 1.2+ and synchronous commit are pinned."
  }

  assert {
    condition     = length(azurerm_management_lock.no_delete) == 1
    error_message = "Deletion protection is on by default."
  }
}

run "standby_in_the_same_zone_is_refused" {
  command = plan

  variables {
    standby_zone = "1"
  }

  expect_failures = [azurerm_postgresql_flexible_server.this]
}

run "geo_backup_without_its_key_is_refused" {
  command = plan

  variables {
    geo_backup_key_vault_key_id = null
  }

  expect_failures = [azurerm_postgresql_flexible_server.this]
}

run "burstable_sku_is_refused" {
  command = plan

  variables {
    sku_name = "B_Standard_B2s"
  }

  expect_failures = [var.sku_name]
}
