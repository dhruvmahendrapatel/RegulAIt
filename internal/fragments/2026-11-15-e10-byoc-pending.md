<!-- fold: pending -->

**E10 — BYOC on AWS follow-ups (ADR-0325, 2026-11-15, lane E10).** (1) PR 2 merged (#868). (2) PR 3: the customer runbook, the smoke test and the `byoc-rehearsal` workflow, which
always destroys and sweeps leftover tagged roles. (2b) Operator backups to S3 (ADR-0305 §2): extend
`backup-target-s3` with a Pod Identity writer mode (PutObject plus S3-conditioned GenerateDataKey/Decrypt, no
ListBucket) and compose it in `byoc-aws`. (3) The first rehearsal in regulait-dev, after the
owner applies the role; its timing and snags go in the PR. (4) Confirm in the rehearsal that `aws:FederatedProvider` is
populated for GitHub OIDC sessions (the workload boundary's federated deny depends on it).
