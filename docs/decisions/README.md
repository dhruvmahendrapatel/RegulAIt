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
