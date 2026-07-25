# Architecture Decision Records

One ADR per architectural/technical decision, numbered sequentially, using
[ADR-TEMPLATE.md](ADR-TEMPLATE.md). Never edit an Accepted ADR's decision after the fact —
superseding a decision means a new ADR plus a status flip on the old one.

| ID | Title | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | 2026-07-21 |
| [0002](0002-two-account-aws-foundation.md) | Two-account AWS Organization for the foundation phase | Accepted | 2026-07-21 |
| [0003](0003-terraform-over-cloudformation.md) | Terraform as the authoritative IaC tool | Accepted | 2026-07-21 |
| [0004](0004-iam-identity-center-no-long-lived-keys.md) | IAM Identity Center only, no long-lived IAM keys | Accepted | 2026-07-21 |
| [0005](0005-token-optimization-tooling.md) | Adopt caveman + graphify, graphify restricted to `--code-only` | Accepted | 2026-07-22 |
| [0006](0006-token-optimization-default-in-future-scaffolds.md) | Token-optimization tooling is a default in every future RegulAIt-built scaffold | Accepted | 2026-07-22 |
| [0007](0007-six-p0-pillars.md) | Escalate to six co-equal P0 pillars (supersedes token-opt "standard feature" framing) | Accepted | 2026-07-22 |
| [0008](0008-eight-p0-pillars.md) | Escalate to eight co-equal P0 pillars (multi-agent orchestration, PM-tool integration) | Accepted | 2026-07-24 |
| [0009](0009-typescript-fastify-stack.md) | TypeScript/Fastify stack with a hand-rolled policy kernel for the governance MVP | Accepted | 2026-07-24 |
| [0010](0010-pm-inbound-sync-webhooks-plus-read-through.md) | PM-tool inbound sync: webhooks + live read-through, no polling | Accepted | 2026-07-25 |
| [0011](0011-shared-projects-on-one-project-entity.md) | Shared Projects extend the one `projects` entity; conflicts ride the one approvals queue | Accepted | 2026-07-25 |
| [0012](0012-admin-portal-single-file-api-client.md) | Admin portal MVP: dependency-free single-file web app, strictly an API client | Accepted | 2026-07-25 |
