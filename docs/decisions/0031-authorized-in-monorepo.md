# ADR-0031: Port regulAIt Authorized into this monorepo, reusing the policy and workflow kernels

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

**regulAIt Authorized** is the second product in the suite. It is an existing, in-production
enterprise access-governance system (formerly "AIMS"): SAP-GRC-style segregation-of-duties
analysis, access request/approval workflow, automated provisioning into SAP/AD/Okta/Entra/
Workday, and emergency ("firefighter") privileged access. It is ~125,000 hand-written lines of
C#/.NET 8 over PostgreSQL, and is being rewritten rather than maintained.

The two products are **not the same product**. Governed enforces entitlements over *AI agents,
models, connectors and MCP tools*; Authorized enforces entitlements over *enterprise target
systems*. Landing a second product in this repo risks diluting the eight-P0-pillar identity that
[CLAUDE.md](../../CLAUDE.md) declares non-negotiable.

Three things argue for it anyway:

1. **Pillars 1 and 2 are already what Authorized needs.** Pillar 1 (default-deny per-user
   entitlements, approvals queue, rate limits, full audit log, admin portal with role builder) is
   the same shape as Authorized's internal RBAC and approval routing. Pillar 2 (declarative
   multi-stage workflow with human sign-off and conditional stages) is the same shape as its
   `WorkFlowType`/`WorkFlowGroup` engine. Reimplementing both in a sibling repo would be
   duplicated work on the hardest parts.
2. **The toolset gap is entirely one-directional.** Authorized has no tests, no CI, no IaC, no
   compose file and no environment separation. This repo has all five.
3. **Both are Postgres-backed and connector-shaped**, so `packages/db`, `packages/shared` and the
   connector abstraction are genuinely common, not superficially so.

Constraints carried over from the source system:

- **14 first-party `Connector.*` .NET packages** hold every SAP/AD/Okta/Graph/Workday/ServiceNow/
  AWS/Salesforce/Jira integration. They are the product's moat and are the largest single item of
  work — likely larger than the application itself.
- **SAP RFC is a native dependency.** The .NET side wraps SAP's NW RFC SDK; the Node equivalent
  is `node-rfc` (official SAP), which needs the SDK at build and runtime.
- **SAML2** is supported today; `openid-client` in this repo is OIDC-only.
- **27 Hangfire job types** in three flavours (recurring, trigger, dependency-chained) behind a
  Postgres advisory lock. This repo has no scheduler at all.
- The source has **zero automated tests**, so "functionality is unchanged" is currently
  unverifiable by any means other than production.

## Decision

Port regulAIt Authorized into this monorepo as **its own app plus its own packages, consuming the
existing kernels as libraries** — never the reverse.

- **`apps/authorized`** — Fastify, mirroring `apps/gateway`'s structure. A separate app, not
  routes bolted onto the gateway: it has its own HTTP surface, its own job runner and its own UI,
  and must be deployable independently.
- **`packages/sod-kernel`** — pure, zero-I/O segregation-of-duties evaluation, following
  `packages/policy-kernel`'s precedent from [ADR-0009](0009-typescript-fastify-stack.md): takes a
  user's effective entitlement set plus a rule set, returns typed conflict findings. No database
  access, so it is directly unit-testable — which the C# original is not.
- **`packages/provisioning-provider`** — connector dispatch and the per-application result
  journal, alongside the existing `connector-provider`.
- **`packages/db`** — **extended, not forked.** Authorized's tables already live in dedicated
  Postgres schemas (`sap`, `risk`, `nav`, `eam`), which map cleanly onto Drizzle's `pgSchema()`.
  One migration pipeline and one pool for the whole repo.
- **Reused unchanged**: `packages/policy-kernel` for entitlement decisions, `packages/
  workflow-kernel` for approval staging, `packages/shared` for zod schemas, plus this repo's CI,
  compose, Terraform and ADR discipline.

Close the three toolset gaps with:

- **pg-boss** for scheduling — Postgres-backed, so no new infrastructure, and its cron/one-off/
  retry model covers Hangfire's three job kinds.
- **`node-rfc`** for SAP, with the NW RFC SDK vendored and checksum-pinned rather than fetched at
  image-build time as the source system does.
- **SAML2 deferred** pending confirmation that any customer actually uses it; OIDC via the
  existing `openid-client` otherwise.

Port in this order, riskiest last: schema (via `drizzle-kit pull` against a live database) →
characterization tests → connectors → jobs → workflow → SoD engine → UI.

**Explicitly not ported**: the DataTables raw-SQL layer (~50 sites interpolating client input
into unparameterised SQL), the unauthenticated REST host and its arbitrary-SQL endpoint, the
`administrator`/`xadministrator` login bypass, reversibly-encrypted passwords, and six identified
correctness defects including a `break`-for-`continue` in partial approvals and a degenerate
range comparison that silently under-reports permission-level conflicts.

## Consequences

**Easier.** Authorized inherits a test harness, CI with a Postgres service, Terraform, compose
and ADR discipline on day one — five deficits closed by the move itself. The two products share
one entitlement model, one audit log and one connector abstraction, so a customer buying both
administers one thing. Extracting `sod-kernel` as pure and zero-I/O makes the compliance
engine unit-testable for the first time.

**Harder.** The repo now carries two products with different release cadences under one CI job;
expect to split the workflow per-app before long. `packages/db` becomes materially larger. The
eight-pillar framing in CLAUDE.md now needs to state explicitly that pillars govern *Governed*,
and that Authorized is a consumer of pillars 1 and 2 rather than a ninth pillar — otherwise the
product identity blurs, which is the main thing given up here.

**Follow-up.** Port the 14 connector packages (the long pole, and not scoped by this ADR).
Confirm whether SAML2 is required. Top up GitHub Actions minutes — CI is currently
`workflow_dispatch`-only, so the safety net this decision depends on is switched off. Write the
characterization tests *before* any logic is ported; without them the "functionality unchanged"
requirement cannot be verified at all.
