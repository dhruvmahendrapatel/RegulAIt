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

## Amendment — 2026-08-13: the self-review guard did NOT survive a delegation

Found reviewing pillar 2 end-to-end. §3 above ends with a flat claim:

> The self-review reason guard still applies through a delegation.

It did not. The guard was written, and nothing tested that sentence.

**The defect.** `decideOneApproval` computed separation-of-duties as a property
of the *row*:

```ts
const selfReview = row.userId === row.approverUserId;
```

That asks whether the template named the requester as the approver. It says
nothing about who actually signed. So an approver who delegates to the
requester hands them their own gate, and the requester decides it as an
ordinary arm's-length review: HTTP 200, no reason required, no `selfReview`
flag on the response, no `approval-self-review` audit row. The one control
standing between a requester and their own governed change was routed around
by a feature two sections up in this same ADR.

Concretely: rex opens a change, ada is the named approver, ada delegates to
rex, rex approves rex — silently.

**The fix.** Separation of duties is a property of the *decider*, so ask that
question of the identity that actually signed:

```ts
const selfReview = row.userId === row.approverUserId || row.userId === deciderUserId;
```

Both disjuncts are load-bearing: the first is the shape a template writes
directly (`approvers: ["requesting_user"]`), the second closes the delegation
route around it. The decision stays *possible* — alternate-approver routing is
still out of scope, and an org that wants none of this has the
`approval_delegation_enabled` master switch — but it is never again silent: a
recorded reason is required and the audit row is stamped, exactly as §3 always
claimed.

The inbox badge moved with it. `GET /v1/approvals` now reports `selfReview` for
three cases, matching decide-time: the template named the requester outright;
the row is already decided and the requester is who signed it (historical fact,
so an auditor reading it back sees the badge, not only the person who did it);
or it is pending and reached **this viewer**, who is the requester, through a
delegation. The last is viewer-relative on purpose — the same row is an
ordinary gate in everyone else's inbox. The warning has to be visible at the
point of decision, not only in the trail afterwards.

**Status of the claim.** §3's sentence is now true rather than aspirational,
and `demo-fixes.test.ts` pins it: the delegated self-decision is refused
without a reason, badged in the requester's inbox, unbadged in the delegator's,
and stamped in the audit trail once decided.

## Amendment — 2026-08-13: the deploy-override escape had no second party either

Found in the same pass, and it is the same defect wearing different clothes.

§6 calls `deploy-override` "the governed **operator** escape", and §2 records
that the driving routes keep "the strict admin/**initiator** gate". Both
sentences are true and together they are the bug: the word *operator* was
carrying a separation-of-duties assumption the gate never enforced. The
endpoint took `{ stageId }` and nothing else — there was no `reason` field in
the schema to supply.

So the requester of a change could clear the deploy gate on their own change.
And that gate parks for exactly one reason: governance found **no authorized
way to deploy** — a missing target, an unmet condition, or a dry-run refused
against production (§6's rule with teeth). "It shipped some other way" is
therefore an *attestation*, and the person attesting was allowed to be the only
person in the room. This repo's own test suite showed it: the pre-existing case
in `workflow-deploy.test.ts` drove the override as the instance initiator under
the comment *"operator resolves the handoff"*.

It was never invisible — `applyEvent` has always written a
`workflow:deploy_override` audit row naming the actor. What was missing is
**why**, and any distinction between an operator closing out a handoff and a
requester waving their own change through.

**The decision.** Treat it exactly as §3's self-review, because it is one:

- the override still **works** — an operator is not always on hand, and
  refusing outright would strand the instance at a stage nothing else can
  clear;
- when the caller **is the instance initiator**, a reason is mandatory —
  `400 deploy_override_reason_required`, and nothing moves;
- an arm's-length admin clearing someone else's parked deploy stays a one-click
  action, matching how §3 treats an admin override versus a self-review;
- either way, a supplied reason is written to a dedicated
  `workflow:deploy-override-attested` audit row carrying `selfAttested` and the
  initiator's id, so the trail distinguishes the two cases instead of flattening
  them into one generic event row.

**Deliberately not done.** Requiring a *second person* (routing the override to
an approver) would be the stronger control, and it is the obvious follow-up.
It is out of scope here for the same reason §3 left alternate-approver routing
alone: it needs a routing policy to say *who*, and inventing one silently is
worse than making the existing self-attestation honest. What ships now is the
guarantee that this escape can never again be taken quietly by the one person
with an interest in taking it.
