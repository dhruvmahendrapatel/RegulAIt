# postgres-ha-gcp

Cloud SQL for PostgreSQL with high availability ([ADR-0343](../../../internal/decisions/0343-control-plane-high-availability.md)).
Project-agnostic.

| Default | Value | Turn it off with |
|---|---|---|
| `REGIONAL`: a synchronous standby in a second zone with automatic failover (RPO 0) | on | `availability_type = "ZONAL"` |
| Daily backups and point-in-time recovery | 14 backups, 7 days of WAL | `backup_retention_count` (7-365), `transaction_log_retention_days` (1-7) |
| Encryption with your Cloud KMS key (CMEK) | required | — |
| TLS required (`ENCRYPTED_ONLY`), `synchronous_commit = on`, IAM sign-in | pinned | — |
| Network | private IP only | — |
| Deletion protection (the Terraform guard and the Cloud SQL API guard); backups kept after deletion | on | `deletion_protection = false` (rehearsals only) |
| Cross-region replica (region loss, asynchronous, promoted by hand) | off | `dr_replica = { region, kms_key_name }` |

`root_password_wo` is write-only and ephemeral, so it is never stored in plan or state. Read it from Secret Manager
with an ephemeral resource; bump `root_password_version` to rotate it. Shared-core tiers are refused because they
cannot run an HA standby.

Connect through `private_ip_address` or the Cloud SQL connector (`connection_name`). Both follow the primary through a
zone failover.

Tests: `terraform init -backend=false && terraform test`. These are plan-only with a mocked provider.
