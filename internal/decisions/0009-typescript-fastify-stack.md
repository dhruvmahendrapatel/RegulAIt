# ADR-0009: TypeScript/Fastify stack with a hand-rolled policy kernel for the governance MVP

- **Status**: Accepted
- **Date**: 2026-07-24

## Context

EPIC-02 (governance layer MVP) is starting and no application code or stack decision exists yet.
The first buildable slice is a narrow vertical of MCP-server governance
([GOVERNANCE_LAYER_SPEC.md §3](../product/GOVERNANCE_LAYER_SPEC.md)): data model, default-deny
policy evaluation, per-user tool-level allow-lists, audit log, minimal API. The stack must later
scale to the admin portal (§6), remain provider-agnostic/deployable BYOC and air-gapped (§8.5 —
plain containers + Postgres, no cloud-service lock-in), and be maintainable by a solo developer
driving AI agents. MCP proxying is central: the gateway sits between MCP clients and upstream MCP
servers, so first-class MCP SDK support matters.

Options evaluated (delegated research, 2026-07-24): TypeScript (Fastify vs NestJS vs Hono) vs
Python (FastAPI); embedded policy engines (OPA/Rego, Cedar, Casbin) vs hand-rolled evaluation;
Prisma vs Drizzle.

## Decision

Build the product as a **TypeScript end-to-end pnpm-workspace monorepo**:

- **`apps/gateway`** — Fastify, using the official `@modelcontextprotocol/sdk` (the reference MCP
  implementation; covers both the server side the gateway presents to clients and the client side
  it uses toward upstream servers).
- **`packages/policy-kernel`** — a **hand-rolled, pure, zero-I/O policy evaluation package** (no
  OPA/Cedar/Casbin). It returns a typed `Decision {effect, ruleId, ruleChain, reason}` consumed
  by the audit log, and later by simulate mode (§5) and cost attribution (§10.4).
- **`packages/db`** — **Postgres + Drizzle ORM** with drizzle-kit migrations.
- **`packages/shared`** — zod schemas/types shared gateway ↔ future admin portal.
- **`apps/admin-portal`** — future React/Vite app (not in this slice).

## Consequences

- One language across gateway, API, and portal: shared zod schemas end-to-end, no type
  duplication — the main maintainability win for a solo-dev, AI-agent-driven build.
- §3's rule model is mostly stateful (rate limits, approvals) or data-shaped (user × server ×
  tool rows), which OPA/Cedar/Casbin don't evaluate natively — an embedded engine would leave
  half the rules in app code (two engines to audit instead of one). Hand-rolling keeps one
  auditable engine and makes "which rule fired" trivial.
- Risk accepted: the kernel could sprawl once conditional/contextual rules (§3) and the
  cross-cutting rule builder (§6) land. Mitigation: keep the kernel pure and the `Decision`
  interface stable so Cedar can be slotted behind it later without touching callers.
- Rejected: Python/FastAPI (bilingual stack, loses portal type-sharing), NestJS (DI/decorator
  ceremony agents mishandle), Hono (thinner server-side plugin ecosystem), OPA (ops burden,
  admin-hostile Rego), Cedar (second-tier Node bindings — revisit later), Casbin (weakest
  explainability), Prisma (codegen engine; Drizzle is SQL-transparent and easier to diff-review).
- Plain containers + Postgres keeps hosted/BYOC/air-gapped viable; AWS/Terraform (ADR-0002/0003)
  remains dev-infra-only.
- Follow-ups: pin the MCP SDK version and isolate transport handling in one module (spec churn);
  decide early whether the DB or git-exported files are the source of truth for policy-as-code
  (§5) serialization.
