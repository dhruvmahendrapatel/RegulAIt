# ADR-0090: Grant certification campaigns — the access-review loop, scoped to gateway grants only

- **Status**: Accepted
- **Date**: 2026-08-21
- **Migration**: 0092 (`grant_certification_campaigns` + `grant_certification_items`). Two TS-only
  enum widenings, no DDL: `approvals.objectType` gains `grant_certification`, `audit_log.objectType`
  gains `certification_campaign` (and `grant_certification`, which the generic decide-path audit
  rows write for these approvals).
- **Driver**: [GAP_ANALYSIS_SAVIYNT_2026-08.md](../product/GAP_ANALYSIS_SAVIYNT_2026-08.md) gap
  **L22** (*"no 'review these 40 grants by March 1' object, no reviewer assignment, no campaign
  audit trail … Defensibility: yes for OUR grants — and our version ends in enforced revocation
  with query evidence, not an attestation export; no for cross-SaaS entitlements"*).
- **Extends**: [ADR-0089](0089-agent-ownership-alignment.md) (the ownership spine campaigns route
  reviewers by — the ADR that named L22 as next), [ADR-0082](0082-inventory-and-posture.md) (the
  grant inventory a campaign reviews; the posture surface the campaigns line joins),
  [ADR-0046](0046-review-workbench.md) (the one `approvals` table + `decideOneApproval`, the
  breach-on-read idiom, per-item refusal semantics), [ADR-0045](0045-model-risk-management.md)
  (the decide-hook pattern the keep/revoke hook copies), [ADR-0022](0022-identity-lifecycle-approver-visibility.md)
  (the self-review lesson, here hardened decider-keyed),
  [ADR-0019](0019-per-user-revocation-and-full-attribution.md) (per-user revocations — read for
  why they are NOT the revocation instrument here).

## Context

Saviynt's core loop is the certification campaign: periodic, owner-driven review of entitlements
with attest/revoke decisions and a campaign audit trail. Everything adjacent already existed here
— ADR-0045 recertifies model-risk sign-offs, ADR-0082 computes granted-vs-observed per agent,
ADR-0089 gives agents owners — but nothing convened a review of WHO HOLDS WHICH GRANT with an
enforced outcome. This ADR builds that loop for the one entitlement set this product actually
enforces.

## Decision

### 1. Gateway grants only — a fabric campaign is refused by construction

A campaign's scope can name: **all gateway grants**, grants on agents **by lifecycle status**,
grants on **one owner's agents** (both ADR-0089 columns put to work), or **one user's direct
grants**. That closed vocabulary (DB CHECK) is the entire reachable universe: the eight grant
kinds are the gateway's own grant tables (agent/connector/MCP tool/server, direct and
role-bundled). There is no connector to another system's entitlements and there will not be one
— certifying Salesforce/SAP access is IGA's fabric; we integrate with IGA, we do not compete
with it. The gap analysis' defensibility line is the spec: our campaign ends in **enforced
revocation with query evidence**, not an attestation export.

Role-bundled grants are reviewed **at role level** (one item: "role R bundles agent A"), never
expanded per holder — expanding would fabricate per-user grant rows that do not exist, and the
`user` scope therefore covers direct grants only.

### 2. The rails question: the approvals queue directly, not a pillar-2 instance

ADR-0080/0084 put registries on workflow rails because their lifecycle IS a staged pipeline
(propose → plan → artifact → sign-off). A campaign is not that: it is N independent,
single-decision attestations by named reviewers — which is exactly what the one approvals queue
already IS. So: opening a campaign snapshots one item per grant and creates **one `approvals`
row per item** (`objectType='grant_certification'`, the item's reviewer as `approverUserId`, the
item id in the `stageId` sentinel — the ADR-0045 model-card shape). Keep = approve, revoke =
deny, both through `decideOneApproval` — there is **no campaign-owned decision endpoint
anywhere**. What that buys without writing a line: the named-reviewer refusal
(`not_the_named_approver`, per item while siblings proceed — the ADR-0046 semantics), ADR-0022
delegation, the admin override with its recorded reason, bulk/ChatOps riding the same path, and
the queue's own labels ("grant certification · holder · object"). A workflow instance per item
would have been ceremony with no stages in it; recorded here as the deliberate leaner fit.

### 3. Reviewer routing — the ADR-0089 ownership spine, honestly limited

An item on an **agent** grant routes to the agent's recorded owner where one exists, is active,
and is not the grant's own holder; every other item — unowned agents, orphaned owners,
connectors/tools/servers (which have no owner concept) — routes to the **campaign opener**.
Routing decides whose queue the item lands in, never who may act: the reviewer becomes the
approval's named approver and the one decide path enforces it.

### 4. A reviewer never certifies their OWN grant — decider-keyed, refused by name

The ADR-0022 lesson (separation of duties is a property of **who actually signed**) hardened
from reason-required to a refusal: before any decision is written, if the DECIDER holds the
grant under review — the item's holder for direct kinds, a current assignee of the role for
role-bundled kinds — the decide is refused **403 `cannot_certify_own_grant`**. Keying on the
decider means the bar also stops a holder reaching their own item through delegation or the
admin override; the suite proves an ADMIN holder deciding with an override reason — the
strongest credential the path accepts — is still refused, for both halves.

### 5. Revoke is real — one removal implementation per grant kind

A revoke decision **executes the grant removal inside the decision's own transaction** (the
ADR-0045 hook position in `decideOneApproval`), so a decision can never commit as
attested-but-unenforced; keep records the attestation and touches nothing. The removals live in
`grant-revocation.ts` — **one exported function per grant kind, now called by both the existing
admin DELETE endpoints (refactored to it) and the campaign executor**, so the campaign cannot
grow a parallel delete. Two findings this forced into the open:

- **ADR-0019 revocation rows are NOT the instrument.** The kernel gives a direct grant
  precedence over a revocation row (a direct grant is itself a per-user override), so inserting
  one would not revoke a direct grant. Deleting the row is the only truthful removal for every
  kind; for role-bundled kinds it is exactly what the role-grant DELETE endpoints already meant.
- **Direct MCP tool/server grants had NO removal path at all** — every other kind had a DELETE
  endpoint, these two had none (and per the above, a revocation row would not beat them). This
  slice adds `DELETE /v1/grants/tools/:grantId` and `DELETE /v1/grants/servers/:grantId` on the
  shared implementation, because a campaign's revoke must be THE path, not a campaign-private
  delete.

Every decision audits with the campaign as context (`grant-cert-keep` / `grant-cert-revoke`,
objectType `certification_campaign`, the mechanism and whether the row was still there in
`detail`); the kernel reads grant rows live, so the removal IS the enforcement.

### 6. Snapshot semantics — a campaign reviews what existed at open

Items are snapshotted at open (grant row id, holder, object, labels): a grant created after open
is **out of scope** — recorded fact, never an implied continuous coverage — and a grant deleted
out-of-band between open and decide leaves the item decidable, with the execution reporting
`removed: false` rather than erroring or pretending. Opening an empty scope is refused
(`no_grants_in_scope`): a campaign with nothing to review is attestation theatre.

### 7. Expiry is a visible posture fact, never a decision

Stored status is only ever `open | completed` (`completed` written when the last item is decided,
in the same transaction). **`expired-incomplete` is computed on read** — open + past due +
undecided items — the ADR-0046 breach-on-read idiom: a pure function of stored state, so it can
never be stale and no scheduler exists to write it. Undecided items **stay undecided forever**:
deciding an item of a past-due campaign is refused **409 `campaign_expired`** (the same shared
past-due predicate, so the read and the refusal cannot disagree), and nothing ever auto-keeps or
auto-revokes — a queue that clears itself on a timeout is a bypass (ADR-0046's own rule). The
posture one-pager gains a campaigns line (open / completed / expired-incomplete), with "no
certification campaign has ever been run" stated outright when the table is empty.

### 8. Routes, SPA, tests

`POST /v1/certification-campaigns` (+ `/preview` with a count-by-kind before committing),
`GET /v1/certification-campaigns` (+ detail) — all admin-only via the default gate, tagged
internal/`certification` in the ADR-0053 registry alongside the two new grant deletes. The
bootstrap token cannot open a campaign (it would be an identityless accountability record). SPA:
a Campaigns page beside the Agent inventory (scope picker with preview count, campaign list with
computed status, item table whose keep/revoke controls render only for the signed-in item's
reviewer) and the posture card. A `zz-zz-` Playwright spec (name sorts LAST — M-018) drives one
item to keep and one to revoke through the real UI and proves the revoked grant gone against the
gateway's own grant read.

Non-vacuity, proven the M-002 way (each probe reverted by reversing the exact edit):

- record-decision-but-skip-execution → exactly the four revoke tests fail (rows still present);
- own-grant bar no-op'd (`if (false && …)`, both halves) → the two bar tests fail (the admin
  holder's override goes through);
- `campaignPastDue` constant-false → exactly the two expiry tests fail (expired-incomplete never
  reads, the late decision lands).

Suite: gateway 138 → 139 files, 2263 → 2279 passed (+16); Playwright 116 → 118.

## Honest limits

- **No scheduler, no notifications.** Due dates are read-time facts: nobody is emailed, nothing
  fires at the deadline, and a campaign nobody looks at is expired-incomplete *in the data* the
  moment anything reads it — the ADR-0046 posture, restated here so it is not filed as a bug.
- **No delegation of review and no reassignment.** The reviewer is fixed at open (owner-else-
  opener); ADR-0022 delegation windows still work on the queue rows, but the own-grant bar is
  decider-keyed precisely so delegation cannot launder a self-certification. An item routed to a
  reviewer who then becomes unavailable is decidable only by an admin override.
- **No periodic auto-campaigns.** Every campaign is an explicit admin act; "quarterly" is the
  operator's calendar, not ours (deliberate — an auto-opened campaign nobody asked for would
  manufacture expired-incomplete posture facts).
- **Coverage is grants-at-open, not continuous.** A grant created a minute after open waits for
  the next campaign; the preview and the payload notes say so.
- **Role-level review is role-level.** Revoking a role-bundled grant strips that access from
  every holder of the role — that is what the item says and what the role-grant DELETE endpoint
  always meant — and per-holder subtraction remains ADR-0019's separate instrument.
- **A keep is an attestation, not a policy claim.** It records that a named reviewer stood
  behind a grant row on a date; ABAC, rate limits, budgets and the rest of the decision chain
  are untouched in both directions.
- **Fabric campaigns stay refused.** The scope vocabulary cannot name another system's
  entitlements; cross-SaaS certification is the IGA we integrate with (pillar 8 posture), not a
  roadmap item hiding in an ADR.

## Amendment (2026-08-22, batch B2) — the expiry sweep (decides nothing) and item reassignment (never to the holder)

Two of this ADR's honest limits were built out; the rest stand.

**B2a — a scheduler job that makes expiry VISIBLE, and is structurally barred from deciding.**
The "no scheduler" limit is closed in the narrowest possible way: an ADR-0064 job
(`certification-expiry-sweep`, off-by-default like every job on that scheduler, hourly default,
with `POST /v1/certification-campaigns/expiry-sweep` as the manual/cron door calling the same
`runCampaignExpirySweep`) whose ONLY write is one audited `campaign-expired-incomplete` row per
campaign the FIRST time it is observed past due with items undecided. The boundary is the
decision of this amendment: **the sweep changes no status and decides nothing** —
`expired-incomplete` stays computed on read, the late-decide refusal stays the same shared
`campaignPastDue` predicate (so the swept event and the read can never disagree), and undecided
items stay undecided forever. What read-time computation could not do is put the fact where
nobody has to open a page to see it; that — and only that — is what the sweep adds. Idempotence
is by data (the audit row is the marker): a re-run adds nothing, ever. Suite: sweep marks
exactly once / re-run adds nothing / a within-due campaign untouched / status-and-event
agreement / the scheduler job runs the identical function through the real claim-lease
machinery. Non-vacuity (M-002): no-op'ing the event write reddens exactly the three sweep tests.

**B2b — reassignment of an ITEM's review, with the holder bar extended to routing.**
The "no reassignment" limit is closed:
`POST /v1/certification-campaigns/:campaignId/items/:itemId/reassign` (admin-only via the
default gate, bootstrap refused, **reason required**, audited `grant-cert-item-reassigned`)
moves an UNDECIDED item's reviewer. The approvals-row move rides
`reassignApprovalApprover` — **extracted from ADR-0046's SLA `reassign` escalation so both
callers share the one pending-guarded approver-moving write** — never a parallel UPDATE.
Refused by name: a decided item (`item_already_decided`), a past-due campaign
(`campaign_expired`, same shared predicate), and — the bar — **the grant's holder**
(`cannot_reassign_to_holder`, both holder shapes: the direct holder and any current assignee of
the bundling role). The §4 self-review bar is decider-keyed at signing time; this extends the
same judgment to routing time, because handing the holder their own item manufactures exactly
the self-certification the decide path refuses — and **an admin override reason does NOT help**
(the ADR-0022 idiom: the bar is about who would sign, not how well the move is documented).
Suite: the reassigned reviewer decides, the original gets `not_the_named_approver`, both holder
shapes refused with an override-style reason, decided/expired refused. Non-vacuity: dropping
the bar reddens exactly the two holder tests (the admin's reason goes through).

Routes tagged internal/`certification` (ADR-0053 registry). SPA: the campaign detail gains a
reassign form (undecided items only, reason required, the gateway refusal rendered verbatim);
the last-sorting Playwright spec drives a reassignment and the holder refusal end to end.

**Still true, restated:** no notifications (nobody is emailed at the deadline — the sweep
writes an audit fact, not an outbox); no periodic auto-campaigns; ADR-0022 delegation windows
are unchanged and remain decider-barred from self-certification.
