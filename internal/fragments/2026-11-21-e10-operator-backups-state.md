<!-- fold: state -->

**E10 — operator backups to S3 built (ADR-0325 PR 4, ADR-0305 §2, 2026-11-21, lane E10).** Item (2b) of the
2026-11-15 E10 pending fragment. `backup-target-s3` gains a `kubernetes_job` writer profile (PutObject on the prefix,
S3-conditioned GenerateDataKey and Decrypt, no List, Get or Delete) and `writer_role_arns`. `byoc-aws/backup.tf`
composes a versioned SSE-KMS bucket and a Pod Identity role bound to `<installation>-backup`, with `operator_backups`
on by default. The output `backup_spec` is the `spec.backup.s3` block. The runbook has a new §6.9 acceptance check and
an uninstall step. The rehearsal sweep empties the backup bucket. Plan-only tests only: no AWS step, no
`terraform apply`. The rehearsal is still parked (D-2026-11-18-09).
