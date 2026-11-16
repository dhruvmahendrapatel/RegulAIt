<!-- fold: state-recap -->
**2026-11-15, lane E10 PR 2: the BYOC AWS module (ADR-0325).** `infra/modules/byoc-aws` builds a VPC with a strict
egress allow-list (AWS Network Firewall; Entra ID sign-in only by default) and VPC endpoints for AWS APIs; EKS with a
private API, KMS-encrypted secrets and NetworkPolicy enforcement on; RDS PostgreSQL 16 (TLS, Multi-AZ, PITR, deletion
protection); one KMS key; the COMPLIANCE audit-anchor bucket; a Bedrock-scoped gateway Pod Identity role; and private
ECR. The customer applies `infra/environments/byoc-aws`, and the rehearsal applies the same root. A read-only
preflight sits next to the module. Nothing is applied yet. Next: PR 3, the install runbook and the `byoc-rehearsal`
workflow.
