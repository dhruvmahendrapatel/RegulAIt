# postgres-ha-aws

PostgreSQL on Amazon RDS with high availability ([ADR-0343](../../../internal/decisions/0343-control-plane-high-availability.md)). Project-agnostic: it knows nothing about RegulAIt.

| Default | Value | Turn it off with |
|---|---|---|
| Synchronous standby in a second AZ, automatic failover (RPO 0) | on | `multi_az = false` |
| Automated backups and point-in-time recovery | 14 days | `backup_retention_days` (1-35; 0 is refused) |
| Storage, master secret, Performance Insights and logs encrypted with your KMS key | required | — |
| TLS required (`rds.force_ssl = 1`), `synchronous_commit = on` | pinned | — |
| Public endpoint | none | — |
| Ingress | 5432 from `allowed_security_group_ids` only | — |
| Deletion protection and a final snapshot | on | `deletion_protection = false`, `skip_final_snapshot = true` (rehearsals only) |

The master password is generated and held by RDS in Secrets Manager (`master_user_secret_arn`). It never appears in a
variable or in Terraform state.

Connect to `endpoint`. RDS moves it to the promoted standby on failover, which typically completes in one to two
minutes, so clients only need to reconnect. The RegulAIt gateway's pool drops broken connections by itself.

## Region loss

`modules/cross-region-backups` copies automated backups to a second region using that region's provider and KMS key.
A restore there is a point-in-time restore you start by hand (ADR-0343 §2: promotion across regions is never
automatic).

```hcl
module "pg" {
  source                     = "../../modules/postgres-ha-aws"
  name                       = "app-pg"
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnets
  allowed_security_group_ids = [module.eks.node_security_group_id]
  kms_key_arn                = module.kms.key_arn
}

module "pg_backups_dr" {
  source                 = "../../modules/postgres-ha-aws/modules/cross-region-backups"
  providers              = { aws = aws.dr }
  source_db_instance_arn = module.pg.db_instance_arn
  kms_key_arn            = aws_kms_key.dr.arn
}
```

Tests: `terraform init -backend=false && terraform test`. These are plan-only with a mocked provider, and no AWS call
is made.
