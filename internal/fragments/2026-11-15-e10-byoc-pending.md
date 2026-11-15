<!-- fold: pending -->

**E10 — BYOC on AWS follow-ups (ADR-0325, 2026-11-15, lane E10).** (1) PR 2: the `byoc-aws` module (VPC with the
Network Firewall allow-list, EKS, RDS, KMS, the audit bucket, Bedrock access, ECR) passing the workload boundary to
every role it creates, plus the preflight. (2) PR 3: the customer runbook, the smoke test and the `byoc-rehearsal`
workflow, which always destroys and sweeps leftover tagged roles. (3) The first rehearsal in regulait-dev, after the
owner applies the role; its timing and snags go in the PR. (4) Confirm in the rehearsal that `aws:FederatedProvider` is
populated for GitHub OIDC sessions (the workload boundary's federated deny depends on it).
