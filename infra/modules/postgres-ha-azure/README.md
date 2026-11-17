# postgres-ha-azure

Azure Database for PostgreSQL Flexible Server with high availability
([ADR-0343](../../../internal/decisions/0343-control-plane-high-availability.md)). Project-agnostic.

| Default | Value | Turn it off with |
|---|---|---|
| Zone-redundant HA: a synchronous standby in a second zone with automatic failover (RPO 0) | `ZoneRedundant` | `high_availability = "SameZone"` or `"Disabled"` |
| Backups and point-in-time recovery | 14 days | `backup_retention_days` (7-35) |
| Geo-redundant backups to the paired region (region loss) | on | `geo_redundant_backup = false` |
| Encryption with your Key Vault keys (primary, and geo-backup when it is on) | required | — |
| TLS 1.2 or later required, `synchronous_commit = on` | pinned | — |
| Network | private access only, through a delegated subnet | — |
| Deletion protection (a `CanNotDelete` lock) | on | `deletion_protection = false` (rehearsals only) |

`administrator_password_wo` is a write-only, ephemeral variable. Read it from Key Vault with an ephemeral resource. It
is sent to Azure and is never stored in plan or state; bump `administrator_password_version` to rotate it. Entra ID
sign-in is enabled alongside the password.

Burstable SKUs are refused because they cannot run an HA standby. Connect to `fqdn`, which follows the primary through
a failover.

Tests: `terraform init -backend=false && terraform test`. These are plan-only with a mocked provider.
