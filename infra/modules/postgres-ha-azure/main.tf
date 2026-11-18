# PostgreSQL Flexible Server with high availability (ADR-0343): a synchronous
# zone-redundant standby with automatic failover, backups with point-in-time
# recovery (optionally geo-redundant), encryption with the caller's keys, TLS
# 1.2 or later required, private access only through a delegated subnet. The
# administrator password is write-only and never reaches state.
#
# Applications connect to `fqdn`; Azure repoints it at the promoted standby on
# failover, so a client only has to reconnect.

locals {
  geo_keys_given = var.geo_backup_key_vault_key_id != null && var.geo_backup_user_assigned_identity_id != null
  identity_ids   = compact([var.user_assigned_identity_id, var.geo_redundant_backup ? var.geo_backup_user_assigned_identity_id : null])
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  version             = var.postgres_version
  sku_name            = var.sku_name
  storage_mb          = var.storage_mb
  auto_grow_enabled   = true
  zone                = var.zone

  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false

  administrator_login               = var.administrator_login
  administrator_password_wo         = var.administrator_password_wo
  administrator_password_wo_version = var.administrator_password_version

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = true
    tenant_id                     = var.entra_tenant_id
  }

  backup_retention_days        = var.backup_retention_days
  geo_redundant_backup_enabled = var.geo_redundant_backup

  dynamic "high_availability" {
    for_each = var.high_availability == "Disabled" ? [] : [var.high_availability]
    content {
      mode                      = high_availability.value
      standby_availability_zone = high_availability.value == "ZoneRedundant" ? var.standby_zone : null
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = local.identity_ids
  }

  customer_managed_key {
    key_vault_key_id                     = var.key_vault_key_id
    primary_user_assigned_identity_id    = var.user_assigned_identity_id
    geo_backup_key_vault_key_id          = var.geo_redundant_backup ? var.geo_backup_key_vault_key_id : null
    geo_backup_user_assigned_identity_id = var.geo_redundant_backup ? var.geo_backup_user_assigned_identity_id : null
  }

  maintenance_window {
    day_of_week  = 0
    start_hour   = 4
    start_minute = 30
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.high_availability != "ZoneRedundant" || var.standby_zone != var.zone
      error_message = "A zone-redundant standby must be in a different zone from the primary."
    }
    precondition {
      condition     = !var.geo_redundant_backup || local.geo_keys_given
      error_message = "Geo-redundant backup with a customer-managed key needs geo_backup_key_vault_key_id and geo_backup_user_assigned_identity_id."
    }
  }
}

# TLS is required by default on Flexible Server; pinned here, with the minimum
# version, so a later configuration change cannot turn it off silently.
resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  server_id = azurerm_postgresql_flexible_server.this.id
  name      = "require_secure_transport"
  value     = "ON"
}

resource "azurerm_postgresql_flexible_server_configuration" "tls_min" {
  server_id = azurerm_postgresql_flexible_server.this.id
  name      = "ssl_min_protocol_version"
  value     = "TLSv1.2"
}

# RPO 0 needs a commit to wait for the standby (`on` is the default).
resource "azurerm_postgresql_flexible_server_configuration" "synchronous_commit" {
  server_id = azurerm_postgresql_flexible_server.this.id
  name      = "synchronous_commit"
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "log_connections" {
  server_id = azurerm_postgresql_flexible_server.this.id
  name      = "log_connections"
  value     = "on"
}

resource "azurerm_management_lock" "no_delete" {
  count      = var.deletion_protection ? 1 : 0
  name       = "${var.name}-no-delete"
  scope      = azurerm_postgresql_flexible_server.this.id
  lock_level = "CanNotDelete"
  notes      = "Deletion protection for the control-plane database (ADR-0343)."
}
