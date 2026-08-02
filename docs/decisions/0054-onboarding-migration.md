# ADR-0054 — Onboarding & migration: an admin setup wizard and import tooling for day-one time-to-value

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0036 (SAML SSO), ADR-0037 / ADR-0038 (IdP provisioning + group→role mapping),
  ADR-0010 (PM inbound sync adapters), ADR-0040 (ABAC / policy-as-code), the compliance-classification
  cascade (GOVERNANCE_LAYER_SPEC §8.3), ADR-0041 (BYOC / air-gapped as the primary motion), the
  standing **provider-agnostic** principle in CLAUDE.md
- **Anchors (already built)**: the admin console already manages users, roles, agent/connector/MCP
  governance; IdP adapters (OIDC/SAML) and PM adapters (Jira, Azure DevOps, Linear, Asana, monday,
  generic webhook) already exist; the single-tag compliance cascade already exists as the mechanism
  a classification fans out through. This ADR sequences those pieces into a first-run experience.

## Context

Everything an enterprise needs to stand RegulAIt up already exists as individual capabilities:
connect an IdP, provision users via SCIM, define roles and policies, connect a model provider,
classify an Initiative for compliance. But a new admin today assembles all of that by hand, route
by route, in whatever order they guess — and in the primary BYOC/air-gapped motion (ADR-0041) they
do it inside their own environment with no RegulAIt operator beside them. The gap between "installed"
and "governing real AI usage" is a manual, order-sensitive slog, and it is exactly where a governance
product loses a pilot: value is not visible on day one.

Two distinct needs sit under "onboarding":

1. **Guided setup** — a first-run wizard that walks an admin through the minimum path to a working,
   governed deployment in the right order, without them needing to know that order.
2. **Migration/import** — bulk-importing the state a customer already has (users, groups, roles,
   existing PM projects/work items) from their existing IdP and PM tools, so they are not
   re-keying an org that already exists elsewhere.

The forces:

- **Time-to-value is the KPI.** The wizard's job is to get from install to "a governed call happened
  and appears in the audit log and cost dashboard" as fast as honestly possible.
- **Provider-agnostic throughout.** The wizard must be IdP-agnostic (any OIDC/SAML), PM-agnostic
  (any of the existing adapters), and model-provider-agnostic (the first connected model is the
  customer's choice) — it never presumes a vendor at any layer.
- **Wizard output must be governable state, not a special mode.** Whatever the wizard produces has
  to be ordinary policy/role/config that the policy-as-code path (ADR-0040) can export, review, and
  version — not a parallel "setup" representation.

## Decision

**Ship an admin setup wizard that sequences IdP connection → SCIM user import → role/policy seeding
→ first model-provider connection → compliance-pack selection, backed by idempotent, resumable
migration/import tooling from existing IdP and PM tools — all producing ordinary governed state.**

### 1. The setup wizard — a guided, ordered, resumable flow

A first-run admin surface in the existing console, a linear flow with a persisted checklist so it is
**resumable** (an admin can leave and return; BYOC installs are done piecemeal) and **idempotent**
(re-running a step reconciles rather than duplicates). The steps, in dependency order:

1. **Connect an IdP** — OIDC or SAML (ADR-0036), IdP-agnostic. Establishes how humans authenticate
   before any users are imported.
2. **Import users via SCIM** — pull the user directory (ADR-0037), with CSV import as the fallback
   for environments without SCIM. Users land as entitled seats (subject to the ADR-0052 seat cap).
3. **Seed roles and policies** — from a small set of **starter role templates** (e.g. Admin,
   Builder, Reviewer, Viewer) the admin can accept or edit, plus IdP group→role mapping (ADR-0038)
   so directory groups drive role assignment at scale rather than per-user clicks.
4. **Connect the first model provider** — the customer's choice of vendor (or a self-hosted endpoint
   per ADR-0034), so a governed dispatch is possible. This is the step that makes the audit log and
   cost dashboard show something real, which is the "value visible" moment.
5. **Pick a compliance pack** — a single classification (HIPAA / PCI-DSS / SOC 2 / GDPR / a custom
   pack) that seeds workflow stages, MCP/connector data-scope defaults, audit-retention, and PII
   mode through the existing §8.3 cascade. One choice configures many controls, which is the point
   of the cascade and the fastest honest path to a compliant baseline.

At the end, the wizard triggers (or prompts for) a first governed call so the admin *sees* it land
in the audit log and the cost dashboard — the concrete day-one proof that governance is on.

### 2. Compliance packs are cascade seeds, not a new mechanism

A "compliance pack" is a named bundle of defaults keyed to a framework that the wizard applies *by
classifying the initial Initiative/workspace* — it rides the existing single-tag compliance cascade
(§8.3) rather than introducing a parallel configuration path. Reclassifying later reuses the same
cascade-diff-and-review flow the cascade already defines. The pack is a starting point the admin can
tighten, never a ceiling that overrides governance.

### 3. Migration/import tooling — meet the customer's existing state

Beyond the wizard's happy path, standalone importers for the state a customer already has, each
built on an **existing adapter** so no new integration surface is invented:

- **Users & groups** — SCIM sync (ADR-0037) and CSV, provider-agnostic across IdPs.
- **Group→role mapping** — importable/exportable as data (ADR-0038), so an org's existing group
  structure maps to RegulAIt roles in bulk.
- **PM projects & work items** — via the existing PM adapters (ADR-0010), map a customer's existing
  Jira/ADO/Linear/Asana/monday projects onto RegulAIt Initiatives, with the PM tool remaining source
  of truth (pillar 8), so the task graph lands on the customer's real work items rather than a shadow
  copy from the first day.

Every importer is idempotent (re-run reconciles) and dry-runnable (preview the diff before
committing), matching the cascade's own "surface a diff before applying" discipline.

### 4. Wizard output is policy-as-code, not a special representation

Everything the wizard and importers produce — roles, policies, mappings, the initial classification
— is ordinary governed state, exportable and version-controllable through the ADR-0040 policy-as-code
path. An admin can complete the wizard once, export the result to their own repo, and reproduce or
review it as code. There is no "wizard mode" that produces state the rest of the product can't read.
This also makes the wizard **replayable** for BYOC/air-gapped rollouts: a reference configuration can
be produced once and applied to a new sovereign deployment as code, without redoing the clicks.

### 5. Provider-agnostic and BYOC-first by construction

The wizard names no vendor at any layer: IdP is any OIDC/SAML, the first model is the customer's
choice (hosted vendor or self-hosted), PM import spans every existing adapter. In BYOC/air-gapped it
runs entirely inside the customer's boundary — SCIM and PM imports reach the customer's own systems,
and nothing about setup requires an outbound call to a RegulAIt-hosted service.

## Consequences

### Easier

- The path from install to a governed, audited, cost-attributed first call is a guided, resumable
  flow instead of tribal knowledge — a direct time-to-value win, and the difference between a pilot
  that shows value on day one and one that stalls in setup.
- A customer's existing org (users, groups, roles, PM projects) is imported rather than re-keyed,
  through adapters that already exist.
- The whole result is policy-as-code, so a reference onboarding can be replayed across BYOC/air-gapped
  deployments without redoing the wizard by hand.

### Harder / given up

- Starter role templates and compliance packs are opinionated defaults we now own and must keep
  current as frameworks evolve; a stale pack is a subtly wrong baseline, so they need review
  ownership, not just an initial authoring.
- The wizard adds a first-run surface with real state-mutation power (it provisions users, seeds
  policy, classifies) — its idempotency and dry-run guarantees are load-bearing and must be tested,
  because a non-idempotent re-run during a piecemeal BYOC install would duplicate or corrupt state.
- The wizard cannot invent integrations: it is only as broad as the existing IdP/PM/model adapters.
  A customer on an unsupported IdP or PM tool falls back to CSV/generic-webhook, which is honest but
  less turnkey.

### Follow-up

- The wizard UI, the resumable-checklist state, and the compliance-pack bundle definitions are
  specified here but not built.
- The importers reuse existing adapters but need a bulk/dry-run/reconcile layer on top that does not
  exist yet.
- Which frameworks ship as first-party compliance packs (vs. custom) is a product decision this ADR
  defers.
