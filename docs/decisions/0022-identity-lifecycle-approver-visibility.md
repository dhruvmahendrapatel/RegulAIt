# ADR-0022 — Identity lifecycle, approver visibility ("party to"), delegation windows, template retire, dry-run deploy honesty

- **Status**: Accepted
- **Date**: 2026-07-31
- **Relates to**: ADR-0021 (org_settings ceiling model), ADR-0015 (air-gapped data boundary), ADR-0012 (portal-as-API-client), roadmap honesty items #79b/#79c

## Context

A hands-on Playwright review of both UIs plus an enterprise-readiness pass found
the platform missing the identity lifecycle every real org needs (no way to
offboard a user, delete a role, retire a workflow), one hard access-model defect
(a named approver 403'd on the very instance they were asked to sign off —
deciding merge gates blind), a set of dead/dishonest surfaces (a "Set approver"
control that did nothing, dry-run BYOC deploys recorded indistinguishably from
real ones), and a batch of practicality gaps. Migration **0039** carries the
schema; this ADR records the decisions with teeth.

## Decisions

### 1. Deactivate ≠ delete (users)

`users.disabled_at` (nullable timestamp) is the ONLY off switch; there is
deliberately **no hard-delete route**. A disabled user's API keys stop
authenticating immediately with a **distinct 401 `user_disabled`** (only the
holder of a valid key ever sees the reason — invalid tokens still get the
generic 401), key issuance is refused (409), and reactivation restores the same
keys untouched. Every FK, audit row, provenance record and ledger entry
survives. Lockout guards: an admin cannot deactivate **themselves**, and the
**last active admin** (isAdmin ∧ not disabled) can be neither deactivated nor
demoted. Promote/demote and rename (display name only — the email is an
identity anchor) are ordinary audited admin acts.

### 2. Approver visibility — the "party to the instance" read

`GET /v1/workflows/instances/:id` now admits, beyond admin and initiator:

- any user **named as approver on ANY approval row of that instance — pending
  or already decided** ("party to": you can review what you are being asked to
  sign, and what you signed);
- an **active delegate** (below) of a user with a **pending** approval row on
  it — they can decide it, so they must be able to see it.

This is a **scoped read, not blanket access**: the participant flag is passed
by the GET route alone; every driving route (artifacts/advance/checks/recheck/
deploy-override/abort) keeps the strict admin/initiator gate, verified by test.
A 403 now says "you don't have access…" (`error: forbidden` + human detail) —
never the outage-flavoured copy. The /app inbox additionally embeds the
merge-gate evidence (PR link, recorded check results, dry-run flag) from the
**stage context** — chosen over a live git-provider fetch because fresher data
requires git credentials the approver may not hold; the stage context is
exactly what the pipeline itself saw.

### 3. Approver delegation windows

`approval_delegations (from_user, to_user, starts_at, ends_at, reason)` —
windows, not standing grants (expiry is the time predicate; no cleanup job).
While active: the delegate's inbox **additionally** shows the delegator's
PENDING approvals (marked `delegatedFrom`), and the delegate may decide them.
The decision records the **real decider** (`approvals.decided_by`) plus an
**on-behalf-of audit row** (`approval-delegated-decision`, naming delegator and
delegation) — both sides in the one trail. Admin-managed; self-service was
optional and is deferred. Org master switch
`org_settings.approval_delegation_enabled` (default true): off = creation
refused **and** existing windows stop applying immediately — for strict
separation-of-duties orgs. The self-review reason guard still applies through a
delegation.

### 4. Roles and teams become fully manageable

Role holders are listable (`GET /v1/roles/:id/assignments`) and unassignable;
all four role-grant types are removable; `DELETE /v1/roles/:id` refuses a HELD
role naming its holders — force requires a recorded reason and audits who held
it. Teams: member removal, and `DELETE /v1/teams/:id` refuses when the team is
the recorded contributor of shared-context revisions, **surfacing what blocks**
(count + project names); force-with-reason overrides. Context provenance is
FK-free by prior design, so even a forced deletion never rewrites history.

### 5. Workflow template retire (not versioning)

`workflow_templates.retired_at/retired_reason`. Retired = starts **no new
instances**; in-flight instances keep their snapshotted definitions untouched;
visible as Retired everywhere with the recorded why. Instance creation that
resolves to a retired template is **refused loudly (422 `template_retired`)
rather than silently skipping it** — silently dropping a routed (possibly
compliance-required) template would let the change through ungoverned. Explicit
choice: retire-with-reason over edit-in-place versioning (instances already
snapshot; versioning adds machinery with no governance gain today).

### 6. Dry-run deploy honesty (#79c) and git-kind honesty (#79b)

`DeployResult.dryRun` is set by every adapter: **true** on every deterministic
dry-run shape (aws-without-live-client, azure, gcp, kubernetes), **false** on
the aws live path — and **false on mock**, a deliberate deviation: the mock
provider is the demo/test double whose deploys ARE its self-describing
(`mock://`) contract, not a pretend run of a real deployment; flipping it would
break the shipped demo pipeline whose behaviour previous ADRs fixed. The flag
is persisted in the stage context **including the air-gapped branch** (a
boolean about our own adapter is metadata and does not cross the ADR-0015
boundary), badged in /app's Delivery row and the approver's inbox, and — the
rule with teeth — **a dry-run never satisfies a production deploy gate**
(target- or change-environment "production"): the stage parks at
`blocked_on_deploy` with the reason spelled out; `deploy-override` remains the
governed operator escape. #79b: `IMPLEMENTED_GIT_PROVIDERS` is exported from
the git-provider package (all five current kinds are implemented) and the
connection-create route 400s on any kind outside it — the NEXT kind added to
the enum fails at creation, never mid-workflow.

### 7. Portal/UX decisions

The dead "Set approver" became a **persisted org setting**
(`org_settings.infra_approver_user_id`, validated active-user, audited,
prefilled on every visit). The audit view exports CSV
(`GET /v1/audit.csv`, admin-only, full filtered trail, same pattern as the
costs CSV). Every native `confirm()` in both UIs was replaced with a shared
two-step inline `confirmClick` (native dialogs silently no-op in embedded
browsers). Sign-in lands in the newest Playground thread (an explicit new-chat
wins); chat bubbles are labelled with the agent actually **served** (requested
stays in the trace); the intake Type select shows its resolved template(s)
live; infra approvals carry a real "Governs" label (resource + finding/action
summary); remaining raw-UUID tables resolve to names with the id kept as chip.

### 8. Org-settings discipline (per the ADR-0021 mandate)

Only two columns were added, both genuine org-level choices:
`approval_delegation_enabled` (orgs plausibly forbid deciding in another's
name) and `infra_approver_user_id` (a setting, needed to make the dead control
real). The other new behaviours are admin-only actions where a toggle would be
dead weight — deliberately not gold-plated. **Deferred, unchanged**: per-team/
per-user interception-surface rollout stays roadmap §6 O13 — not built here.

## Consequences

- Migration 0039 is behaviour-preserving until an admin acts (nullable columns,
  default-true delegation switch, empty delegation table).
- The access model widened in exactly one place (instance READ for parties/
  active delegates); the full suite plus targeted tests pin that nothing else
  moved (452 → 473 tests, all green).
- The BYOC dry-run shapes can no longer masquerade as production deploys; a
  live AWS client (ADR-0015 A1) is now the only way through a production gate
  besides an explicit, audited override.
