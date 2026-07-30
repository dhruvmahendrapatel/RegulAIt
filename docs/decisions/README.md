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
| [0013](0013-dev-app-deploy-single-ec2-compose.md) | Dev app deployment: one EC2 box running docker compose, SSM-only, separate Terraform state | Accepted | 2026-07-25 |
| [0014](0014-role-bundled-agent-connector-grants.md) | Role-bundled agent + connector grants (UNION-MAX, additive; per-user revocation added by ADR-0019) | Accepted | 2026-07-27 |
| [0015](0015-byoc-deploy-modes-data-boundary.md) | BYOC deploy targets: hosted/BYOC/air-gapped modes + AWS assume-role adapter + air-gapped control-plane data boundary | Accepted | 2026-07-28 |
| [0016](0016-transitive-per-node-budget-ceiling.md) | Team-Lead transitive per-node budget ceiling (MIN up the lead chain; delegation only tightens) | Accepted | 2026-07-30 |
| [0017](0017-infra-ops-automation-ledgers.md) | Infra-ops automation ledgers (cert rotation, CVE patching, backup/restore) behind the one findings surface + one Approvals Queue | Accepted | 2026-07-30 |
| [0018](0018-six-dimension-assignment-matching.md) | Assignment matching expanded to 5 wired dims (target-system + initiator-role added; initiatorRole server-resolved, never client-supplied); data-sensitivity wired in the 2026-07-30 addendum — matrix now 6/6 | Accepted | 2026-07-30 |
| [0019](0019-per-user-revocation-and-full-attribution.md) | Per-user agent/connector revocations (deny-only, bounding ADR-0014's UNION-MAX) + MCP proxy project attribution, so every governed entry point rides one usage ledger and one PII path; ADR-0015 A4 assessed and deliberately still deferred | Accepted | 2026-07-30 |
| [0020](0020-ide-interception-compat-endpoints.md) | IDE / existing-agent interception (ROADMAP Batch H): provider-shaped `/v1/messages` + `/v1/chat/completions` as translation shims over the one governed dispatch core (never a second policy path), admin-selectable model→agent resolution with default-deny on unresolvable, new surfaces OFF by default and 404 when disabled, and an admin-declared enforcement posture the product states honestly | Accepted | 2026-07-30 |
| [0021](0021-org-settings-configurability-layer.md) | `org_settings` singleton (migration 0038) as the single home for org-wide functional defaults: pillar-6 technique toggles + dials, semantic-cache/compaction policy, PII/env-fallback/budget/quorum/retention/worker-cap/size-ceiling choices — under the ceiling model (org ≥ user, narrowing only) with behaviour-preserving defaults as a migration invariant; `streaming_on_block_mode` + `strict_field_rejection` folded into `interception_settings` | Accepted | 2026-07-30 |
