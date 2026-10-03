# ADR-0168: Governance flow — one registry, a lifecycle tracker, and a review task with real outcomes

- **Status**: Accepted (owner, 2026-10-03)
- **Date**: 2026-10-03

## Context

The owner judged the governance flow — intake and decision — "raw and unfinished". Three inputs
shaped what it must contain: an AI-governance whitepaper (use-case record fields, approval
criteria, tiered routing, change-triggered re-review), *The governed agent* (agents as
non-human identities with a named steward and successor, least privilege, lifecycle reviews) and
NIST AI RMF 1.0 (MAP 1-5 context, MEASURE evidence, MANAGE 1.1 go/no-go with documented residual
risk, GOVERN 1.5 periodic review). The owner also supplied a walkthrough of an established
data-governance product's AI-governance tour as the target for flow and look; it is kept out of
this public repository, and nothing here copies its branding.

What the product had: three ways to propose a use case (the intake wizard, a four-step "Propose"
form on the register, a questionnaire drawer), three places to decide (Inbox, Approvals queue,
Review workbench) each with a bare Approve/Deny and a reason box, an approval that never expires,
one reviewer whatever the tier, and the proposer as the only owner.

## Decision

**The flow, as the owner set it (2026-10-03):**

1. **One entry point.** The intake wizard is the only way to propose an AI use case. The
   register's "Propose" form and the questionnaire drawer are removed; every "new use case"
   control opens the wizard.
2. **A registry, not a list.** Use cases (and, later, agents and models) live in one registry with
   headline counts, filterable columns (name, type, status, owner, tier, created) and a split
   "Register AI use case" action.
3. **Registration is short; the work is a tracked lifecycle.** Registration captures what is needed
   to start (name, purpose, owner) and shows similar existing use cases before a duplicate is
   created. The use case then carries a **lifecycle tracker** — Ideation → Under review → Approved
   / Monitoring — whose activities (business context, EU AI Act screening, data and models, risks
   and safeguards, sign-off) show status, assignee and last update, derived from records that
   already exist rather than re-typed.
4. **The decision is a task with real outcomes.** The reviewer works from one review panel that
   shows what is being decided (tier and why, risks with residual ratings, controls, the
   questionnaire, the stack) beside the decision. Outcomes: **approve**, **approve with
   conditions**, **send back for information**, **reject**.
5. **Conditions follow model-risk practice.** Each condition has an owner and a due date and is
   tagged by the reviewer as **before go-live** (it blocks deployment: the deploy gate refuses
   while it is open) or **after go-live** (tracked and escalated when overdue, never blocking).
6. **An approval has a lifetime.** Approval records a "valid until": **12 months** for minimal and
   limited tiers, **6 months** for high; a prohibited screening is never approvable. Expiry puts
   the use case back into review.
7. **Board roles and risk acceptance are configuration, not code** — an admin setting names the
   reviewer roles a tier routes to and who may accept risk. *(After 2026-10-05.)*
8. **Agent ownership follows the governed-agent model** — each agent is an identity in the agent
   inventory with a named steward, a successor and lifecycle reviews; use cases link to agents.
   *(After 2026-10-05.)*
9. **No change of stack.** The look comes from layout and design tokens (a navy header band per
   record, white cards on a light canvas, one accent, sentence case, generous spacing) on the
   existing React + Vite UI. Nothing in the reference requires a different framework.

**Scope before the 2026-10-05 demo** (owner: "half working is better than what we have now"):
items 1-6 for the demo path (intake → use-case record → review → approval), with the live demo
journey re-verified end to end before anything is pushed. Items 7-8, scheduled re-review jobs,
change-triggered re-review, a portfolio dashboard and a home "My tasks" view follow after.

## Consequences

- The demo script's intake, use-case and approval beats change wording and clicks; the script and
  the real-database journey test move with the code, never after it.
- "Approve with conditions" and "send back" are new decision values on the approvals API; old
  clients that send only approved/denied keep working.
- A blocking condition is one more reason the deploy gate can refuse, audited like the others.
- Expiry needs a sweep to flip expired approvals back into review; until that job exists the
  "valid until" date is displayed and enforced at the deploy gate, not swept.
- Removing two intake entry points deletes code and tests that exercised them; nothing else may
  create a use case outside the wizard's path (the API stays, for integrations).

## Implementation status (2026-10-03)

Items 1-6 shipped to `dhruv/active` for the 2026-10-05 demo, built in three worktrees
(`wt-gov-review`, `wt-gov-intake`, `wt-gov-api`): the web commits `048f557..c981eab`, then the
gateway merge `a1d5937` (migration 0129); tip `cbf85a2`, then `40f7f2c` (a phase2 e2e fix).
The Decision section above is unchanged.

**What shipped**
- **One entry point (items 1, 3).** The intake wizard is the full-page "Register AI use case" with
  a similar-use-cases rail (`b7fdabf` duplicate detection, `7c42ee6`); the register's Propose form
  and questionnaire drawer are deleted, and the real-database specs no longer drive them
  (`675fe84`).
- **The AI registry (item 2).** The use-case register is the "AI registry" page, list first, one
  primary action (`8ee4755`, `1062c0a`).
- **The use-case record.** Header band, lifecycle tracker and a conditions section (`d6e9fb7`).
- **The review panel (item 4).** A review task drawer with four outcomes (`048f557`, `ed88596`):
  *Approve*; *Approve with conditions* — a **before-go-live** condition blocks the deploy gate
  (`open_blocking_condition`), an **after-go-live** one is tracked (item 5); *Send back for
  information* — the approval is `returned`, the use case `needs_info`, and the workflow instance
  goes back to its questionnaire stage through the kernel event `approval_returned` (`5803af3`);
  *Reject*. Gateway: `d554185` (migration 0129: `use_case_conditions`, approval lifetime,
  `needs_info`), `bd88929`.
- **Approval lifetime (item 6).** Approval records `approvedUntil`: 6 months for high, and for
  unscreened or prohibited screenings; 12 months for minimal and limited. The deploy gate refuses
  an expired approval as `approval_expired`.
- **Reviewer access.** The reviewer of a pending or decided intake sign-off, and an active
  delegate, may read the use case; `GET /v1/approvals` rows carry `useCaseId`, and the review
  panel uses it when present (`46f121e`, `ed88596`).
- **Demo path.** The real journey and the demo script follow the new flow (`c981eab`, `cbf85a2`).

**Evidence.** Full suite green on the integrated tree (gateway 3356 tests); `demo:prepare` 18/18;
the real demo journey green — Avery approves with a before-go-live condition, and the test
asserts the 6-month validity and one open condition; mocked suite 54/54; approval-review 4/4. CI
run `37125215948` at `40f7f2c` green, including the new "Mocked UI suite" step (`6da2627`) and
the phase1/phase2 spa-journeys. Gateway coverage: `zz-adr0168-use-case-conditions.test.ts`,
`packages/shared/src/deploy-gate.test.ts`, `packages/workflow-kernel/src/index.test.ts`.

**Known limits**
- No in-UI resubmission path for a `needs_info` use case yet: the drawer links to the generic
  workflow page.
- No expiry sweep: `approvedUntil` is displayed and enforced only at the deploy gate (as the
  Consequences above anticipated).
- Reviewers routed by role or team cannot yet read the use case — only the named reviewer of the
  sign-off and an active delegate; the delegate read is untested.
- With an all-must-approve quorum, conditions recorded by one approver persist if a later approver
  denies or returns the sign-off.
- Items 7-8 (board roles and risk acceptance as configuration; agent stewardship) are deferred to
  after 2026-10-05, with scheduled and change-triggered re-review, the portfolio dashboard and
  "My tasks".
- Later the same day (`7a40d77`, ADR-0167 AER-048 amendment) the `approval_returned` re-open also
  bumps the workflow round, so a returned use case's resubmission runs in a new round and earlier
  check reports cannot count for it.

## Amendment 2026-10-03 (owner, afternoon) — the rest of the flow moves before the demo

The owner moved the deferred items forward ("these are also important for Monday — build them
before Monday") and decided AER-049:

1. **AER-049 — a change after merge or deploy needs a new review round.** Merge, PR and deploy
   records belong to the round that produced them. A re-open after something shipped is a change:
   it runs the review again (as the review policy requires for the tier) and produces a fresh PR /
   deploy; earlier rounds' records are kept as history, never reused as "already done".
2. **The number of reviews is configurable ("one or more").** An admin-editable **review policy**
   names reviewer roles (e.g. privacy, security, legal, model risk) with their members and, per EU
   AI Act tier, which roles must sign — each named role is one required review. No roles configured
   keeps today's single named approver. The same policy names who may **accept risk**.
3. **Risk acceptance** is a decision a named risk acceptor can record on a sign-off, against
   specific risks, with a rationale; the risks read *accepted* and the acceptance is audited.
4. **Resubmission** — a use case sent back for information is updated and resubmitted from the
   registration screen (prefilled), producing a new questionnaire version and a new review round.
5. **Expiry sweep** — a scheduled job moves use cases whose approval expired back into review
   (a new sign-off per the policy), audited; the deploy gate keeps refusing until re-approved.
6. **Agent stewardship (item 8)** — every agent carries a named steward and a successor, a
   lifecycle status and a next-review date; an agent whose steward is deactivated is flagged as
   orphaned.

## Implementation status — afternoon amendment (2026-10-03)

All six amendment items are built and merged on the integration branch `wt-g2-int` (from
`dhruv/active` `d9abbe2`): worktrees `wt-g2-api` (merge `695cec9`), `wt-g2-agents` (`87f2cbe`),
`wt-g2-theme` (`516280b`, ADR-0169), `wt-g2-web` (`ebccbd8`) and `wt-g2-aer049` (`90cfb1b`), then
`f0adbd2`, `a1b679e`, `05f1f38` and `f49abb2` on the branch. Full gate on the integrated tree
(wt-g2-int) green: suite 3401 passed / 9 skipped, demo:prepare 18/18, real journeys 2/2 (Monday
demo + review-policy), mocked UI 86/86, phase1+phase2 39/39 after one test-locator fix, approval-review 4/4. The Decision and the amendment above are unchanged.

**What was built**
1. **AER-049 — effect records belong to their round** (`385631d`, `604158b`, `69bb1ad`, review
   fixes `a1b679e`). Every effect record (`branch`, `prId`/`prUrl`, `mergeSha`, `deploy:<stage>`,
   `deployUrl`, `rollback:<stage>`, `runId:<stage>`) is stamped with its round and stage in
   `effects:stamps`; a re-open moves the records of every stage that runs again into the
   append-only `effects:history` (audited `workflow:effects-archived`), the git chain (branch, PR,
   merge) as one unit. The new round cuts its own `<prefix>/<id8>-r<round>` branch, opens a NEW PR
   (body lines `regulait-round:` and `regulait-supersedes:`), merges and deploys again; merge
   refuses a PR its round did not open (`workflow:merge-refused-stale-pr`); mock and dry-run deploy
   ids carry the round from round 1 on. The kernel's generic `reopen` event is the one event a
   completed instance accepts (aborted, denied and rolled-back instances stay terminal), and its
   target must be a `human_approval` or `artifact_generation` stage already passed that sits at or
   before the first PR / merge / deploy / rollback stage (`create_branch` ships nothing, so a
   review after it is still a valid target) — a re-open therefore always runs review again before
   anything ships. `reopenWorkflowInstance` is an internal primitive (callers own authorisation);
   with no human actor it audits as a named system actor, never the initiator. Spec:
   [WORKFLOW_ENGINE_SPEC](../product/WORKFLOW_ENGINE_SPEC.md) stages 8, 10 and 11.
2. **Review policy — "one or more reviews"** (`b2b2e38`, `8fe866b`; migration 0131). One org row
   `governance_review_policy`: roles (name, members), per EU AI Act tier (and "unscreened") the
   roles that must sign plus an optional approval lifetime, and the risk acceptors;
   `GET`/`PUT /v1/governance/review-policy`, audited `review-policy-updated`. When a tier routes to
   roles, the intake sign-off becomes one approval row per role (`review_role_id`, a name snapshot,
   `review_round`; audited `use-case-review-round-opened`). Any member of the role decides its row;
   the proposer never may (`403 proposer_cannot_review`, also as delegate or admin); the stage
   advances only when every role row is approved, whatever the org's quorum dial. A send-back or
   reject on one row ends the round and closes its siblings (`superseded`, shown as *Closed —
   another review ended the round*). No policy, or a tier with no roles, keeps the single named
   approver unchanged. Web: the **Review policy** page (`b997130`, nav `ed03b18`), the review panel's
   *n of m reviews* and other reviews (`b72634f`), one sign-off row per required review on the record
   (`d8f007b`).
3. **Risk acceptance on decide** (`b2b2e38`, `b72634f`). `acceptRisks` (risk ids + rationale) on an
   **approve** of an intake sign-off, refused by name before anything is written: `403
   not_a_risk_acceptor`, `422 risk_not_on_use_case`, `409 risk_already_accepted` / `risk_terminal`.
   The risks read *accepted* with who and why; audited `use-case-risk-accepted`.
4. **Resubmission** (`396a683`, `79ffc7f`, `1aecb8c`, `05f1f38`). Registration stores every Classify
   answer (`ai_use_cases.intake_answers`, the 19 keys) as `screeningAnswers`; `PATCH` in `needs_info`
   takes the same set, merges it, and recomputes the tier and data sensitivity. **Update and
   resubmit** is the registration screen in resubmit mode, prefilled with every answer, the
   send-back reason shown, the name read-only (PATCH has no name edit); it produces a new
   questionnaire version and a new review round.
5. **Expiry sweep** (`b2b2e38`, `f0adbd2`). Scheduler job `use-case-recertification` (hourly) and
   the admin endpoint `POST /v1/governance/recertification/sweep` move an approved use case whose
   `approvedUntil` passed back to `under_review` with `recertification = true` and re-open its
   completed intake instance at the sign-off stage through `reopenWorkflowInstance` (actor
   `system:recertification-sweep`), with one review per role the policy requires; audited
   `use-case-recertification-started` (with `workflowRound`). Idempotent; the deploy gate keeps
   refusing until the new round approves. The registry shows a **Re-review** status and filter.
6. **Agent stewardship** (`5e6f86b`, migration 0132; web `499d2f5`; seed `0741abd`). Details below.

**Stewardship design choices**
- The **steward is the existing ADR-0089 owner column** (`owner_user_id`), exposed as
  `stewardUserId` — no second "owner" to drift. New: `successor_user_id` (CHECK steward ≠ successor),
  `next_review_at`, `last_reviewed_at`, `last_reviewed_by_user_id`.
- Lifecycle widened to **proposed / active / under_review / suspended / deprecated / retired**; a
  non-active status needs a reason; retired is terminal. **Suspended refuses dispatch** with `409
  agent_suspended` (audited).
- `PATCH /v1/agents/:id/stewardship` (admin or the current steward; audited
  `agent-stewardship-updated`) and `POST /v1/agents/:id/stewardship/review` (audited
  `agent-stewardship-reviewed`). Review cadence: **6 months** when a live linked use case is high
  — **prohibited counts as high** — otherwise 12.
- **Orphaned** and **review overdue** are computed at read time: orphaned = no steward, or a
  deactivated one. A successor who steps up (owner route, PATCH, or the remediation executor)
  clears the successor slot, so the CHECK can never fail mid-write.
- The seed gives every agent a steward and successor through the real audited routes and leaves
  **grok** with only a successor (Dana), so the inventory shows one Orphaned flag and the demo's
  unowned-agent alert keeps an executable remediation, which now promotes the successor.

**Evidence** (the implementers' runs and the integration gate as reported): gateway full suite
3401 passed; `zz-adr0168-review-policy.test.ts` 14, `agent-stewardship.test.ts` 13/13 (8
negative-control probes, each reddening only its target), `workflow-check-round.test.ts` 17;
workflow-kernel 50/50; web unit 156/156; mocked UI 86/86 (incl. `zz-review-round.mock.spec.ts`,
`zz-agent-stewardship.mock.spec.ts`); the new real-gateway journey
`apps/web/e2e/demo-review-policy.spec.ts` (Ada sets high → Security = Avery, Privacy = Dana, 12
months, Avery risk acceptor; registers; Dana sends back; resubmit; round 2 both approve, Avery
accepts a risk; `approvedUntil` = `approvedAt` + 12 months) passed together with the Monday
journey `demo-intake.spec.ts` on one `demo:prepare` database (the policy spec restores the policy
it changed). AER-049 had two adversarial reviews: "ship" with two should-fixes, both fixed in
`a1b679e`.

**Earlier limits now closed:** in-UI resubmission (item 4); the expiry sweep (item 5);
role-routed reviewers can read the use case (a member of a role with a review row on it);
items 7-8 are built (amendment items 2, 3 and 6).

**Known limits**
- Seeded personas are only Ada, Dana and Avery, so a demo policy can name at most two reviewer
  roles with distinct people besides the proposer.
- A retry after a failed registration refuses changed Classify answers: the AER-046 checkpoint
  treats `screeningAnswers` as fixed after creation (PATCH takes them only in `needs_info`).
- A member of a review role can read every use case that ever had a review row for that role,
  including earlier rounds, not only the round in front of them.
- ADR-0022 delegation on a role row works only from the row's named approver; a role member cannot
  delegate their role's review.
- An earlier round's PR that was never merged stays open on the git provider (the adapter has no
  close operation).
- `effects:history` is recorded and audited but not shown in the UI; it is read from the
  instance context or the audit trail.
- The all-must-approve quorum limit above (conditions recorded by one approver persist if a later
  one returns the sign-off) was not re-examined for policy-routed rounds.
