# ADR-0208: Lifecycle for compliance profiles, infrastructure and libraries (G7–G9)

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The after-demo add/delete gap review (#453) found objects that could be created but never changed through review,
retired, deleted or cancelled. The owner approved the designs for G7–G9 on 2026-10-29 (#453, comment 6509969403):

| Gap | Decision |
|---|---|
| G7 Compliance profiles | **As shown:** reviewed versions with a diff and a named reviewer. Retire needs a step-up and is **blocked by any carrier** (projects, pending projects, teams and resources). |
| G8 Infrastructure | **As shown:** edit and retire. Policy retire shows the fallback. No new scan-interval field. |
| G9 Libraries | **As shown:** retire datasets and red-team versions, edit and delete schedules, cancel campaigns. The dismiss button reads "Keep campaign". |

Also: `ReasonModal` keeps the typed reason when the server refuses, a shared fix.

On 2026-10-30 (#453, comment 6522492997) the owner unparked the set: build the gateway routes and migrations now,
lazy-load the new screens, keep the all-JS ceiling at or below 1,060 kB and the entry ceilings unchanged. This lane
holds migrations 0223–0225 and this ADR number.

The shared rules from the approved proposals apply to all three: relaxing or retiring needs a step-up where the design
says so; disabling, deleting and retiring are audited and refused while the object is still in use; nothing that is
evidence is ever deleted; every new route is in the OpenAPI map and the route classes, and the UI census keeps
`KNOWN_UI_GAPS` at 0.

## Decision

### G7 — compliance profiles (migration 0223)

1. **An edit is a proposed version.** `POST /v1/compliance/profiles/:id/versions` (admin) takes the versioned fields,
   a named reviewer and a reason (10–2,000 characters). An omitted field keeps its current value; an explicit null
   removes it. The route mints the next version as a **draft** in `config_versions` and puts it in the one approval
   queue as approval kind `compliance_profile`, assigned to the reviewer. It answers `202 {pending, approvalId,
   version, changes, loosens, reach}`: the field-by-field diff, the fields that loosen a floor, and the projects,
   pending projects, teams and resources the change reaches. Nothing applies until the reviewer approves.
2. **The reviewer is an active administrator other than the author** (`422 reviewer_is_author`,
   `422 reviewer_not_eligible`). In the decide path, `cannot_approve_own_compliance_profile_change` is keyed on the
   decider, so the author cannot reach the review through delegation or the admin override.
3. **One review at a time** (`409 compliance_profile_version_pending`, with the approval id). `422 no_change` when the
   proposal equals the current version; `422 unknown_template` for a template id that does not exist.
4. **Step-up when the change loosens a floor** (`settings_relax`, bound to the profile id and the loosened values,
   judged by the existing `COMPLIANCE_PROFILE_LOOSENING` comparator), taken from the author when the change is
   proposed. A tightening change needs none.
5. **Approval applies exactly what was reviewed, or nothing.** Inside the decision's transaction the draft becomes the
   active version only if the profile is still active and the version it was proposed against is still the active one.
   Otherwise the approval is recorded `compliance-profile-version-stale` and nothing changes. Running workflow instances
   of every project carrying the tag then get the additive changes only (the ADR-0027 reapply rule: a relaxation is
   surfaced manual, never applied). A denial changes nothing. Audit: `compliance-profile-version-proposed`,
   `-approved`, `-rejected`, `-stale`, each with the version, the approval id and the diff or the reason.
6. **Retire.** `POST /v1/compliance/profiles/:id/retire {reason}` (admin) always needs a `settings_relax` step-up
   (it removes floors). It is refused while any project, pending project (a reclassification awaiting review),
   team (default classification) or infrastructure resource carries the tag (`409 compliance_profile_in_use`, listing
   each by name), and while a version waits for review. The carrier check runs again under the profile's row lock.
   Audit `compliance-profile-retired`, in the same transaction.
7. **A retired profile is read-only and takes no new carrier.** New versions, the upsert-by-tag path and the onboarding
   pack refuse it (`409 compliance_profile_retired`), and so do classifying or reclassifying a project, creating a team
   and creating or editing an infrastructure resource with that tag. Its versions and history are kept, and the
   audit-retention floor it set still counts, so retiring never shortens audit retention. `profilesForTags` still
   resolves retired profiles, so a carrier that slipped in through a race stays governed by the old floors (fail closed).
8. **The upsert-by-tag path never clears a floor.** `POST /v1/compliance/profiles` on an existing tag now writes only
   the fields the body names; an omitted field keeps its stored value (the server half of #602). It remains the
   policy-as-code path for automation, admin-only, with the step-up on any loosening (ADR-0186 decision 29). The
   profiles page no longer offers it for an existing tag: the "New profile" card only creates, and an existing tag
   changes through Edit profile, which a reviewer approves.
9. `GET /v1/compliance/profiles` lists each profile with its active version, its status and retired facts, its
   carriers by name (`usage`) and any pending review. The carriers come from four grouped queries, not one per profile.
10. Migration 0223 adds `status` (active | retired), `retired_at`, `retired_reason` and `retired_by_user_id` to
    `compliance_profiles`, with a CHECK tying the retired facts to the status. `retired_reason` is registered for the
    prose scrub. Nothing is backfilled (ADR-0180).

### G8 — infrastructure resources and policies (migration 0224)

1. `PATCH` and `POST …/retire {reason}` for `/v1/infra/resources/:id` and `/v1/infra/policies/:id`, admin-only.
   Deleting would erase the remediation ledgers, so these objects are retired, never deleted.
2. **Step-up** (`settings_relax`) when an edit loosens (drops a classification tag, a slower patch cadence, a higher
   auto-remediation ceiling, a shorter backup retention, a smaller certificate-rotation lead time) and always for
   retire, which stops monitoring.
3. Retiring a resource is refused while remediations wait for approval or are approved but not applied.
4. Retiring a policy shows the fleet policy the resource falls back to, before and after the confirmation. The fleet
   policy can be edited, not retired. At most one active policy per resource, and one active fleet policy, enforced by
   partial unique indexes.
5. Every create, edit and retire is audited in its transaction (creation was not audited before).
6. **No scan-interval field** is added.
7. Retired resources and policies are read-only and excluded from scans, effective-policy resolution and new work.

### G9 — libraries (migration 0225)

1. **Eval datasets.** `POST /v1/evals/datasets/:id/retire {reason}` retires a dataset by name (all versions). Refused
   while a workflow quality gate or an automation rule uses it (`409 eval_dataset_in_use`, naming the templates and
   counting the rules); built-ins cannot be retired. No step-up: blocking new use fails closed.
2. **Red-team library versions.** `POST /v1/redteam/libraries/:id/retire {reason}` retires one version, with a
   step-up for a published one (it stops scheduled sweeps). Refused while a run of it is in progress.
3. **Engine schedules.** The owner edits the interval through `PATCH /v1/engine-schedules/:id` and the next run moves
   to match; `DELETE /v1/engine-schedules/:id` soft-deletes it (owner or admin, no step-up). A run in progress keeps
   going.
4. **Certification campaigns.** `POST /v1/certification-campaigns/:id/cancel {reason}` with a step-up. Pending reviews
   are withdrawn from reviewers' queues; decisions already made, revocations included, stand. The dialog's dismiss
   button reads "Keep campaign".
5. Each action has its own audit rule id and records the reason. Retired, deleted and cancelled objects stay readable.

### Shared

- `ReasonModal` keeps the typed reason when the server refuses: the text is cleared when the dialog closes, not when
  it is confirmed. It also takes an optional `cancelLabel`.
- The new screens and dialogs are lazy-loaded. The all-JS ceiling stays at or below 1,060 kB, with any raise recorded
  as a dated `CEILING_EXCEPTIONS` row and an ADR-0196 addendum citing #453 c6522492997; the entry JS and entry CSS
  ceilings are unchanged.

## Consequences

- A compliance profile change is now a two-person action in the UI, with the diff and its reach on record. The
  upsert-by-tag API path still edits directly (admin-only, step-up on loosening); see the open question below.
- Retire is refused rather than cascaded everywhere, so an admin reclassifies first. A retired profile's floors cannot
  silently govern a new object.
- Three migrations land in this lane (0223–0225), each hand-written with its journal `when` from the reservation
  formula in #453 c6522492997.

## Open questions

1. Should the upsert-by-tag path refuse an existing tag (so every profile edit is reviewed, from the API as well as the
   UI)? It is kept as a direct, step-up-gated edit for policy-as-code because the brief requires it never to clear
   floors, which presumes it stays; many suites drive it. Owner's call.

## As built (2026-10-30, PR #606)

### G7 (migration 0223)

- Routes: `POST /v1/compliance/profiles/:id/versions` (202), `POST /v1/compliance/profiles/:id/retire` (200), both
  admin-only; module `apps/gateway/src/compliance-profile-lifecycle.ts`. The decide path's hooks are
  `precheckComplianceProfileDecision` and `applyComplianceProfileDecision`; the queue label reads
  "compliance profile '<tag>' v<n>".
- Refusals: `unknown_compliance_profile` (404), `compliance_profile_retired`, `compliance_profile_already_retired`,
  `compliance_profile_in_use` (with `projects`, `pendingProjects`, `teams`, `resources` by name),
  `compliance_profile_version_pending` (with `approvalId`) (409); `reviewer_is_author`, `reviewer_not_eligible`,
  `no_change`, `unknown_template` (422); `cannot_approve_own_compliance_profile_change` (403, decide path).
- Audit rule ids: `compliance-profile-version-proposed`, `compliance-profile-version-approved`,
  `compliance-profile-version-rejected`, `compliance-profile-version-stale`, `compliance-profile-retired`.
- Drafts are minted through `proposeRuleVersion` in `rule-writes.ts`, so that module stays the only one that mints
  versions of a rule artifact (`rule-write-guard.test.ts`); the retire write is an audited writer there (lifecycle
  columns only, none versioned).
- A retired infrastructure resource (G8) no longer counts as a carrier.

### G8 (migration 0224)

- Routes: `PATCH /v1/infra/resources/:id`, `POST /v1/infra/resources/:id/retire`, `PATCH /v1/infra/policies/:id`,
  `POST /v1/infra/policies/:id/retire` (returns `{policy, fallback}`). The UI reads the active fleet policy from the
  existing `GET /v1/infra/policies` to show the fallback before confirming.
- Refusals (409): `infra_resource_retired`, `infra_policy_retired`, `infra_resource_remediations_pending` (with
  `findingIds`), `infra_fleet_policy_not_retirable`, `infra_policy_already_active` (with `existingPolicyId`),
  `infra_resource_name_taken`, `changed_concurrently`; 404 `unknown_resource`, `unknown_policy`.
- Audit rule ids: `infra-resource-created`, `infra-resource-updated`, `infra-resource-retired`, `infra-policy-created`,
  `infra-policy-updated`, `infra-policy-retired`.
- Partial unique indexes `infra_policies_active_resource_uq` and `infra_policies_active_fleet_uq`, with their
  duplicate checks in the deferred-unique preflight.
- Beyond the design: retiring a resource also retires its active resource-scoped policy (its own audit row). A retired
  resource keeps its name, and names stay unique. Retired resources are left out of scans, backup verification and the
  posture count; naming one in a scan, remediation, rotation, patch, restore or new policy is refused.
- Deviation: the design lists "removing the auto-remediation cap" as loosening. In the code a null
  `autoRemediateMaxSeverity` means "never auto-remediate", the strictest value, so clearing it is treated as tightening.
  Clearing patch cadence, backup retention or the rotation lead time is loosening.

### G9 (migration 0225)

- Routes: `POST /v1/evals/datasets/:id/retire`, `POST /v1/redteam/libraries/:id/retire`,
  `PATCH` and `DELETE /v1/engine-schedules/:scheduleId` (in `NON_ADMIN_ROUTES`, object-level checks in the handler),
  `POST /v1/certification-campaigns/:campaignId/cancel`.
- Refusals: `eval_dataset_builtin`, `eval_dataset_in_use` (`templates`, `automationRules`),
  `eval_dataset_already_retired`; `redteam_run_in_progress`, `redteam_library_already_retired`; `schedule_owner_only`
  (403), `engine_schedule_not_found` (404); `campaign_not_open` (with `status`). Downstream: `eval_dataset_retired`,
  `redteam_library_retired`, `campaign_cancelled`.
- Audit rule ids: `eval-dataset-retired`, `redteam-library-retired`, `engine-schedule-updated`,
  `engine-schedule-deleted`, `certification-campaign-cancelled`.
- The next run after an interval edit is `max(now, last scheduled run + new interval)` on the database clock. An admin
  can still switch off another person's schedule, as before, but only the owner changes its interval.
- Deviations: the automation action that writes to a dataset is `{type: "dataset", datasetId}` (the brief's
  `add_to_dataset` was a guess); cancel also refuses an expired-incomplete campaign, so cancelling cannot hide that
  posture fact. `ReasonedAction` takes a `submit(reason)` callback instead of a path, so the route census sees each
  screen's call; campaign cancel and red-team retire go through `withStepUp`.

### Open questions added while building

2. Should engine anchor libraries (`engine:<id>`) and the `redteam:*` datasets a library publishes be blocked from
   retirement?
3. Creating an automation rule checks for a retired dataset outside a transaction, so a narrow race remains; use of a
   retired dataset still fails closed further down.
