# ADR-0170: Separation of duties and lifecycle integrity in the governance flow

- **Status**: Accepted (owner asked for the security review 2026-10-03 and, for every governance
  choice, "whichever is best practice"; the defaults below are best practice and each is a
  separate, reversible rule)
- **Date**: 2026-10-03
- **Amends**: ADR-0168 (and its 2026-10-03 afternoon amendment)

## Context

The owner asked for an adversarial security review of the governance flow built under ADR-0168
(review policy, conditions, resubmission, recertification, agent stewardship). Three independent
reviewers covered authorization, tenant isolation and lifecycle/gate integrity.

**Tenant isolation**: no finding. One deployment is one customer (ADR-0041); the new tables follow
the singleton pattern. If the deferred multi-tenant tier is ever funded, the policy singleton,
`approvals.review_*`, the use-case recertification/answers columns and the four agent stewardship
columns all need an org key — recorded here so that work starts from a list.

The other two reviews found that the flow enforced *who may act* on each step, but not
*separation of duties across steps*: one person could satisfy every required review, the proposer
could clear their own before-go-live condition, an approved round could be followed by an edit the
earlier reviewers never saw, and an agent's steward could lift a suspension an admin imposed.

## Decision

1. **Each required review in a round is decided by a different person.** A decider who already
   decided another review row in the same round is refused (`reviewer_already_decided_round`),
   including an admin override. The proposer is refused as before.
2. **Role rows are decided by live role members only** (or an admin override with a reason). Being
   the row's stored approver is not enough — routing, claim and SLA reassignment no longer touch
   review-role rows, and a member removed from the role can no longer decide. Delegation on a role
   row is honoured only from a live member who is not the proposer.
3. **A before-go-live condition is closed by someone other than the proposer** (maker–checker): the
   condition owner when that is not the proposer or use-case owner, a reviewer who decided the
   use case's approval, or an admin — with a note saying what was done. After-go-live conditions
   keep the ADR-0168 rule (owner, use-case owner, admin).
4. **What is under review cannot change under the reviewers.** While a use case is `under_review`
   its material fields are locked (409 `locked_under_review`); a change goes through *send back
   for information*, which opens a new round.
5. **Screening never silently downgrades.** A resubmitted questionnaire without a screening block
   keeps the last computed tier instead of falling to "unscreened".
6. **An approval without an end date is not an approval without end.** Migration 0133 backfills
   `approved_at`/`approved_until` for use cases approved before ADR-0168 shipped lifetimes, and the
   runtime use-case gate refuses an expired approval as the deploy gate already did, instead of
   waiting for the next recertification sweep.
7. **A steward may tighten an agent's lifecycle, never loosen it.** Steward (non-admin) may move an
   agent to `under_review` or `suspended`; only an admin may make it `active` again, retire it, or
   activate a `proposed` agent. A steward's `nextReviewAt` is capped at the cadence (6/12 months)
   and only an admin may clear it. Lifecycle writes are compare-and-swap.
8. **Smaller hardening.** The proposer cannot accept risks on their own use case; deactivated users
   cannot be named as role members, risk acceptors or condition owners; one failing use case no
   longer aborts the recertification sweep; the review-round sync a decide performs before its
   authorization check is attributed to the system, not to the caller.

## Consequences

- The Monday demo journeys are unaffected (distinct reviewers per role, the condition is shown open,
  not closed). Mocked suites are updated where they assumed the old rules.
- **Known limits, unchanged**: risks accepted on one role's approval stay accepted if a later
  reviewer returns or denies the round; the review panel can show a previous round after a
  resubmission drops to a tier with no roles; at runtime, open before-go-live conditions block the
  deploy gate, not dispatch.
