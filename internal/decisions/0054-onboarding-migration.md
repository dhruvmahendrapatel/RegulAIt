# ADR-0054 — Onboarding & migration: an admin setup wizard and import tooling for day-one time-to-value

- **Status**: Accepted
- **Date**: 2026-08-01 (amended 2026-08-02 on implementation)
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

---

## Amendment — 2026-08-02 (implementation)

Accepted and built, with **three deviations stated plainly**.

### Migration 0066 — two tables, and the shortness of that list is the design

`packages/db/migrations/0066_onboarding_migration.sql`.

Everything the wizard produces lands in the tables it would have landed in had an admin clicked
through the existing console — `roles`, `group_role_mappings`, `compliance_profiles`,
`projects.classifications`, `users`. That is §4, and it is what makes the result exportable and
replayable. What genuinely exists nowhere else is HOW FAR THROUGH the wizard this deployment is,
and WHAT AN IMPORT DID:

- **`onboarding_steps`** — `step_key` is the **primary key**, and that single fact is the whole
  idempotence story. One row per step in the entire deployment means a write can only be an
  upsert, so "ran the step twice" and "ran it once" are the same row. There is no wizard-session
  id, so a piecemeal BYOC install cannot accumulate two contradictory answers to "is the IdP
  connected?". A CHECK ties `status='done'` to `completed_at IS NOT NULL`, so an interrupted write
  either landed as a complete transition or did not land.
- **`onboarding_imports`** — every import, *including the refused ones*. A payload that tried to
  mint an administrator is a row here plus an `audit_log` deny, because that is exactly the event
  an operator needs to find months later, and a browser error message is not findable.

(Migration **0065 was deliberately skipped** — ADR-0053 needed no schema.)

### What was built

| Piece | Where |
| --- | --- |
| Step graph, transition rule, starter templates, compliance packs, import planners, escalation screen, RFC-4180 CSV reader | `packages/shared/src/onboarding.ts` |
| The eight routes | `apps/gateway/src/onboarding.ts` |
| Schema + migration | `packages/db/src/schema.ts`, `packages/db/migrations/0066_onboarding_migration.sql` |
| The first-run SPA surface | `apps/web/src/views/admin/settings/FirstRunPage.tsx` (`/admin/first-run`) |
| Proof-by-attack suite (31 tests) | `apps/gateway/src/onboarding.test.ts` |

Routes: `GET /v1/onboarding`, `POST /v1/onboarding/steps/:stepKey`,
`POST /v1/onboarding/roles/seed`, `POST /v1/onboarding/compliance-pack`,
`POST /v1/onboarding/imports/users`, `POST /v1/onboarding/imports/group-roles`,
`GET /v1/onboarding/imports`, `GET /v1/onboarding/export`. All admin-only through the default
gate; all tagged `internal` in the ADR-0053 spec, because an admin-console surface must stay free
to move.

### It complements ADR-0041's installer, and does not overlap it

`scripts/install.sh` brings the DEPLOYMENT up — containers, TLS, the data key, the bootstrap
token. By the time anything here runs, that is done and an admin is looking at a console. Nothing
here touches deployment concerns and nothing in the installer touches these. The two are named in
each other's headers so the boundary is not folklore.

### Deviation 1 — the checklist reports what an admin ASSERTED *and* what the deployment SAYS

The ADR describes a persisted checklist. A persisted checklist alone becomes a lie the first time
someone tears down the provider they ticked the box for. So `GET /v1/onboarding` returns `status`
(recorded) **and** `satisfied` (computed live from the objects that actually exist) as separate
fields, plus `drift: true` when they disagree. `resumeAt` answers "where was I?" from a query
rather than from the admin's memory. This is additive to the ADR and is asserted by test: a step
marked done whose backing rows are deleted reads `done` + `satisfied: false` + `drift: true`, not
green.

### Deviation 2 — there is no "Admin" starter role template

§1.3 lists "e.g. Admin, Builder, Reviewer, Viewer". Four templates ship — **Builder, Reviewer,
Viewer, Operator** — and `Admin` deliberately does not. In this product platform-admin is
`users.is_admin`, a per-user flag, and ADR-0038 pins structurally that there is no code path from a
group (or a role) to it. A starter role *named* "Admin" that cannot make anyone an admin would be a
trap: an operator would assign it, believe they had delegated administration, and be wrong.

Related: **starter roles are seeded with no grants at all**, and the response says so. A template
pre-wired to "all servers, read-write" would demo beautifully and would be a governance product
shipping a default-allow. The value a template carries is the role STRUCTURE, not pre-granted
access.

### Deviation 3 — PM project/work-item import is NOT built

§3 names three importers. Two ship (users & groups; group→role mappings, importable *and*
exportable as data — the export's `groupRoleMappings` is a valid import payload, and the round trip
is tested). **PM projects & work items are not implemented** and are not claimed. That importer
needs a bulk/dry-run/reconcile layer over the ADR-0010 adapters that does not exist, and the ADR
itself lists exactly that layer as follow-up. Shipping a half-reconciling PM importer would be
worse than saying it is not here.

### The privilege-escalation guarantee, and how it is proved

An import payload is a file someone else wrote. Four walls, in order:

1. `screenForEscalation` runs on the **raw body before any parse** and refuses a payload carrying a
   privilege word at any depth — `isAdmin`, `is_admin`, `IS-ADMIN`, `grants`, `permissions`,
   `superuser`. A 422 with the rule id `onboarding-import-privilege-refused`, an `audit_log` deny,
   and a `refused` row. **Not a silent strip** — a strip would leave the importer believing the
   administrators landed, which is the worse outcome.
2. The row schemas are `.strict()` and have **no privilege field to parse into**. Even bypassing
   (1), there is no code path that reads one.
3. Provisioning calls `refuseIfSeatCapReached` — the *same* function `POST /v1/users` calls. Bulk
   arrival is not a way past ADR-0052's seat cap.
4. `isAdmin` is not in the insert's values object. Not `false` — **absent**.

And role membership is never named by the file: a row carries GROUPS, and what a group confers is
decided by a mapping an admin authored. A group→role import naming a role that does not exist is
refused **whole** rather than creating it, because a file that defines an entitlement bundle is a
file defining policy, and policy is authored, not imported.

Asserted by test: the `isAdmin` attack tried four ways (JSON, snake_case, CSV column, a `grants`
key), each refused, audited, recorded — and each asserted to have created **no user at all**; the
unknown-role import refused whole with no role and no mapping created; the seat cap enforced
against a real signed license; every import applied leaving `isAdmin === false` on every row.

### Still follow-up

- The PM project / work-item importer (the bulk/dry-run/reconcile layer over the ADR-0010 adapters).
- Wiring the export into the ADR-0040 policy-as-code versioning path rather than serving it as a
  document.
- Which frameworks ship as first-party packs beyond the four here (HIPAA, PCI-DSS, SOC 2, GDPR), and
  who owns keeping their numbers current as the frameworks move.
