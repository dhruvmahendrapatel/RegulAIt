---
phase: governance-mvp-in-progress
last_updated: 2026-07-24
active_epics: [EPIC-02, EPIC-03, EPIC-04, EPIC-05, EPIC-06]
open_questions_open: []
last_session: sessions/2026-07-24-session-02.md
---

# RegulAIt — Project State

## Where we are (read this paragraph first)
The infrastructure bootstrap phase (EPIC-01) is **complete**. The private GitHub repo
[dhruvmahendrapatel/RegulAIt](https://github.com/dhruvmahendrapatel/RegulAIt) is live with the
full scaffold. AWS is a two-account Organization (Management `913436627353` / Workload
`regulait-dev` `517506432475`), IAM Identity Center only (no long-lived keys), and the full
security baseline — org-wide CloudTrail, GuardDuty, Security Hub (FSBP + CIS standards), AWS
Config with a cross-account aggregator, account-level S3 Block Public Access, a $5/month Budget,
3 SCPs, and all three permission sets (`Admin-BreakGlass`, `Deploy-Builder`, `ReadOnly-Audit`) —
is applied via Terraform (`terraform plan` reports zero drift). The `github-oidc-role` module is
authored but intentionally not wired into `main.tf` yet — no workload exists to deploy.
Full narrative, including two real incidents worth reading before touching this infra again, is
in `sessions/2026-07-21-session-01.md`.

**Product scope escalated twice more, 2026-07-24: now eight co-equal P0 pillars, not two.**
ADR-0007 (six pillars) added infra-ops/compliance-cascade/deployment-model, Shared Projects, and
a cost-per-project dashboard to
[GOVERNANCE_LAYER_SPEC.md](../docs/product/GOVERNANCE_LAYER_SPEC.md) (now §8–§10), and escalated
token/cost optimization to full P0 pillar in
[TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md). ADR-0008 (eight
pillars) added two more, each in its own new spec doc:
[MULTI_AGENT_ORCHESTRATION_SPEC.md](../docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md) (pillar
7 — PM→Team-Lead→Worker delegation, task-graph DAG, entitlement inheritance never escalation,
per-run budget caps) and
[PM_TOOL_INTEGRATION_SPEC.md](../docs/product/PM_TOOL_INTEGRATION_SPEC.md) (pillar 8 —
Azure DevOps/Jira/etc. as the system of record, not a shadow copy). `CLAUDE.md` and `VISION.md`
updated to list all eight. **No AWS/Terraform infrastructure change was needed for either
escalation** — nothing is deployed yet (EPIC-02 through EPIC-06 haven't started), so both were
spec-only updates.

**EPIC-02 started, 2026-07-24 (session 02).** Stack chosen and recorded as ADR-0009 (TypeScript
end-to-end: Fastify + official MCP SDK planned, hand-rolled pure policy kernel, Postgres +
Drizzle, pnpm monorepo). First vertical slice of MCP-server governance is **built and green**
(21 tests: 13 kernel unit, 8 gateway integration against Postgres 16): `packages/policy-kernel`
(default-deny, per-user×server×tool allow-lists, read-only-all server grants, typed
`Decision {effect, ruleId, ruleChain, reason}`), `packages/db` (schema + first migration:
users/mcp_servers/mcp_tools/tool_grants/server_grants/audit_log — audit rows deliberately have
no FKs so they survive deletions), `packages/shared` (zod schemas), `apps/gateway` (Fastify:
admin CRUD, `/v1/evaluate` writes an audit row for every decision, visible-tools endpoint
implements §3's visibility filtering). Work is on branch `claude/status-check-2gbrwf` (draft PR).
**Not yet in the slice**: roles, agents/connectors/initiatives object types, admin portal.

**Data-scope rules landed (PR #5) — §3 feature-complete for the MCP object type.** Kernel:
`DataScopeRule` input (per-user×server, optional tool scope, dot-path into call arguments,
allowed-values list) — all matching rules must pass (AND), missing/non-scalar values fail
closed, violations deny before rate limits or approvals are consulted (order: grants →
default-deny → data-scope → rate-limit → approval → allow). Gateway: `data_scope_rules` table
(migration 0002), `POST /v1/rules/data-scopes`, and the proxy now passes each call's arguments
into `governedEvaluate` so scope is enforced on real MCP traffic.

**Approvals + rate limits landed (PR #4)**: the kernel now returns a third effect,
`require_approval`, and takes approval rules (per-user×server, optional tool scope, optional
write-only, named approver) and rate limits (per-user×server, optional tool scope, caller-supplied
usage counts — kernel stays zero-I/O) as inputs. Rule order: grants → default-deny (nothing
rescues an ungranted call) → rate limits (exhausted limit denies even with an approval in hand) →
approval rules → allow. Gateway: `approval_rules`/`rate_limits`/`approvals` tables (migration
0001), §6 Approvals Queue endpoints (`GET /v1/approvals`, `POST /v1/approvals/:id/decide` —
named-approver-only, 403 otherwise), rule CRUD, and proxy `tools/call` enforcement: paused calls
create/reuse one pending queue entry; approved entries are consumed atomically by exactly one
retried call (single-use); usage counting = audit-log allow rows in the limit's window.

**Session 02 continued**: CI added (`.github/workflows/ci.yml` — build + all tests on every
PR/main push against a Postgres 16 service container; PR #2, merged). Then the **real MCP proxy
path** landed (PR #3): `POST /mcp/:serverId` speaks streamable-HTTP MCP on both sides via
`@modelcontextprotocol/sdk` v1.29 (gateway = MCP server to clients, MCP client to upstream) —
`tools/list` auto-syncs the upstream tool manifest into `mcp_tools` (kind inferred from
`annotations.readOnlyHint`, defaulting to write) and filters through `visibleTools()`;
`tools/call` runs the kernel, audits every decision, and only forwards allows upstream. User
identity is an interim trusted header (`x-regulait-user-id`) until real authn lands. E2E-tested
with a real in-process upstream MCP server and real MCP client (26 tests total).

## Epics
| ID | Name | Status | Related |
|---|---|---|---|
| EPIC-01 | Bootstrap: AWS foundation + GitHub repo + session-continuity scaffold | **done** | ADR-0001–0004 |
| EPIC-02 | Governance layer MVP (now includes infra-ops/compliance-cascade/deploy-model, Shared Projects, cost dashboard — §1–§10) | **in progress** — stack chosen (ADR-0009), first slice = MCP-server governance vertical | GOVERNANCE_LAYER_SPEC.md, ADR-0007, ADR-0009 |
| EPIC-03 | Workflow engine MVP (now includes optional Design/Architecture sign-off stage type) | not started | WORKFLOW_ENGINE_SPEC.md, ADR-0007 |
| EPIC-04 | Token/cost optimization MVP (escalated to P0) | not started | TOKEN_OPTIMIZATION_SPEC.md, ADR-0007 |
| EPIC-05 | Multi-agent orchestration MVP (PM/Team-Lead/Worker delegation) | not started | MULTI_AGENT_ORCHESTRATION_SPEC.md, ADR-0008 |
| EPIC-06 | PM-tool integration MVP (Azure DevOps/Jira/etc.) | not started | PM_TOOL_INTEGRATION_SPEC.md, ADR-0008 |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | **applied**, zero drift | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | **applied** (Admin-BreakGlass imported from its manual bootstrap creation, other two created by Terraform) | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | **live and private**: https://github.com/dhruvmahendrapatel/RegulAIt | EPIC-01 |
| COMPONENT-05 | Admin portal | not started | EPIC-02 |
| COMPONENT-06 | Policy/allow-list engine | not started | EPIC-02 |
| COMPONENT-07 | Workflow orchestrator | not started | EPIC-03 |
| COMPONENT-08 | caveman (output token compression, Claude Code plugin) | **installed**, user scope, no restrictions (verified fully local) | ADR-0005 |
| COMPONENT-09 | graphify (code knowledge graph, Claude Code skill) | **installed**, project scope, restricted to `--code-only` (verified) | ADR-0005 |

## Decisions
See [docs/decisions/README.md](../docs/decisions/README.md) for the full ADR index. All nine
ADRs (0001–0009) are Accepted. ADR-0009 (2026-07-24) chose the product stack: TypeScript
end-to-end — Fastify gateway + official MCP SDK, hand-rolled pure policy kernel (typed
`Decision` object, no OPA/Cedar), Postgres + Drizzle, pnpm-workspace monorepo
(`apps/gateway`, `packages/policy-kernel`, `packages/db`, `packages/shared`).

## Open Questions
None open. OQ-004 fully resolved: (a) caveman + graphify installed and documented (ADR-0005);
(b) standing policy for future scaffolds recorded (ADR-0006, no implementation yet — nothing to
apply it to until EPIC-02/03 produce a first template); (c) full product-feature spec written —
[docs/product/TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md), explicitly
scoped as a standard feature area (not a third P0 pillar), reusing the governance layer's
per-user entitlement system for model routing and the workflow engine's tag mechanism for a new
cost-sensitivity tag — cross-referenced from VISION.md §5.

OQ-001 (region allowlist) defaulted to `["us-east-1", "us-east-2"]` and is applied as the
region-allowlist SCP; OQ-002 (budget cap) resolved to $5/month; OQ-003 (GitHub account) resolved
to personal `dhruvmahendrapatel`.

## Known follow-ups (not urgent, not blocking)
- Security Hub's default standards enabled **both** AWS Foundational Security Best Practices and
  CIS AWS Foundations Benchmark v1.2.0 (the latter wasn't explicitly requested — AWS enables it
  by default alongside FSBP). Harmless; disable the CIS subscription later if its findings become
  noise.
- `infra/modules/aws-security-baseline`'s Config aggregator authorization assumes `us-east-1`
  only (single-region aggregation) — revisit if resources start landing in `us-east-2`.
- The forecasted (not actual) monthly spend shown in `aws budgets describe-budgets` was ~$1.21 at
  last check — almost entirely the two KMS CMKs (state bucket + CloudTrail). Nothing alarming
  against the $5 cap, but worth a glance next session.

## Standing guardrail
Nothing gets a "production" designation, and nothing deploys to one, without the user's direct,
explicit sign-off in that session. See [CLAUDE.md](../CLAUDE.md).
