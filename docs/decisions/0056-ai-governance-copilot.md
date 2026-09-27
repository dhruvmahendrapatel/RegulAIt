# ADR-0056: AI Governance Copilot — a governed agent that reads the audit trail and proposes, never acts

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

RegulAIt now emits a rich, structured governance record: an append-only, FK-free `audit_log`
(every allow/deny/approval decision with `user_id`, `server_id`, `tool_name`, `effect`, `rule_id`,
`rule_chain`, `reason`), a measured `usage_events` ledger (per-call provider/model/tokens/cost/
savings/refusal), workflow-instance events, approvals-queue history, and the compliance cascade's
classification state. That record is the single most valuable asset the platform holds — and today
it is only usable by someone who can write SQL or read CSV exports (ADR-0031). A compliance officer
who wants "who accessed PII last quarter, and under which approvals?" has to file a ticket to an
engineer. The audit trail is a system of record with no natural-language front door.

An LLM is the obvious front door. But bolting a chatbot onto the audit log naively would be the
single most dangerous thing we could ship: an agent with read access to *the entire governance
record of every user* is a catastrophic exfiltration and privilege-escalation target, and an agent
that could *act* on what it reads (tighten a policy, revoke a grant, close an approval) would be an
ungoverned control-plane actor — precisely the anti-pattern the whole product exists to prevent.

So the design tension is: deliver the enormous usability win of natural-language governance
analytics **without** creating a privileged agent that sits outside the governance boundary. The
resolution is the ultimate dogfood — the copilot must be *just another agent that RegulAIt
governs*, inheriting entitlement, audit, budget, and PII handling through the exact same
`executeGovernedDispatch` kernel as any customer workload, guardrailed at runtime (ADR-0042) and
red-teamed on a schedule (ADR-0057) like any other governed agent. If our own flagship agent
cannot be safely run through our own kernel, the kernel is not fit to sell.

## Decision

Build the **AI Governance Copilot** as a first-class governed agent — routed through
`executeGovernedDispatch`, provider-agnostic via the ADR-0034 model catalog — that is **read-mostly
by construction** and whose every write/action proposal routes through the existing Approvals
Queue. It is not a privileged system component; it is a dogfood tenant of the platform.

**1. Governed like any other agent, not exempt from anything.** The copilot runs under an identity
with its own per-user/per-role entitlements (GOVERNANCE_LAYER_SPEC §2–§5). Its every model call
writes a `usage_events` row and bills a project (pillar 5); its every tool call writes an
`audit_log` row; it obeys the initiating user's per-run budget ceiling (ADR-0016) and the
compliance classification (§8.3) of the context it operates in. **The copilot can never see more of
the audit log than the human who invoked it is entitled to see** — a compliance officer scoped to
one Initiative gets answers over that Initiative's records only. There is no "copilot super-reader"
grant. This is enforced at the query boundary (the copilot's audit-read tool applies the caller's
entitlement filter server-side), not by prompting the model to behave.

**2. A read-mostly tool surface over the governance record.** The copilot is given a small set of
**read-only, parameterized** tools — not raw SQL — over `audit_log`, `usage_events`, workflow
events, and approvals history: e.g. `queryAuditDecisions(filter)`, `summarizeUsage(dimensions)`,
`listApprovals(state)`. These are the same keyset-paginated, windowed, entitlement-filtered access
paths the exports (ADR-0031) and reporting layer (ADR-0047) already use — the copilot is a
*consumer* of that read layer, not a new privileged path into the database. Parameterized tools
(vs. free-form SQL) bound what it can ask for and keep every question auditable as a structured
tool call.

**3. Four capabilities, all landing as drafts or proposals.**

- **Draft compliance reports.** "Produce the Q3 PII-access report for the HIPAA Initiative." The
  copilot queries the record and drafts a report — feeding the reporting layer (ADR-0047) and the
  compliance packs' evidence queries (ADR-0058) rather than inventing its own report format. Output
  is a **draft for human sign-off**, never a filed attestation.
- **Answer natural-language questions over the audit.** "Who accessed PII last quarter?" "Which
  denied MCP tool calls spiked this week?" Answered from tool results, with every underlying query
  logged, so an answer can be traced back to the exact records that produced it.
- **Propose policy tightening from observed patterns.** "Users X and Y have had a write-tool grant
  they've never used in 90 days — propose revoking it." "This rule fires deny 400×/day; propose
  making it an approval instead." Each proposal is a **concrete, reviewable policy diff**, not an
  applied change.
- **Flag anomalies.** Surface unusual patterns (a usage/cost spike à la pillar 5's anomaly
  detection, a burst of denials suggesting a misconfigured agent, an approval consistently
  rubber-stamped in <2s). Flags are leads for a human, tagged with the evidence that triggered
  them.

**4. Every write/action goes through the Approvals Queue — no exceptions.** The copilot has **no
mutating tools**. A policy tightening it proposes is materialized as an Approvals-Queue item
carrying the exact policy-as-code diff (GOVERNANCE_LAYER_SPEC §5); a named human approver applies
or rejects it, and the application is a normal governed action attributed to *that human*, not to
the copilot. The copilot's role ends at "here is a proposed change and the evidence for it." This
is the same "writes pause for human approval" pattern the product applies to every other agent,
turned on its own most-privileged-looking feature.

Worked example of the full loop: an officer asks *"find grants nobody is using and clean them
up."* The copilot calls `queryAuditDecisions` and `summarizeUsage` (both entitlement-filtered to
the officer's scope), finds three write-tool grants with zero invocations in 90 days, and returns
a summary plus **three separate Approvals-Queue items**, each holding the precise revocation diff
and the evidence (the zero-use query result) that justifies it. The copilot has now written
nothing. An approver reviews each item; applying one is a governed revocation (ADR-0019) attributed
to the approver, audited under their identity with a `rule_id`, and visible in the very audit log
the copilot reads — so the next time it is asked, it sees its own prior proposal's outcome.
Rejecting an item is equally logged, and a pattern of instant rubber-stamps is itself an anomaly
the copilot can later flag.

**Data boundary.** In BYOC/air-gapped mode (ADR-0015), the copilot's model call still routes
through `executeGovernedDispatch`, so *where* its inference runs follows the deployment's own
model-endpoint posture (ADR-0034) — the audit content it reasons over never has to leave the
customer boundary to be analyzed, provided the customer routes the copilot to an in-boundary
endpoint. The copilot inherits, rather than widens, the §8.4 control-plane/execution-plane split.

**5. Guardrailed and red-teamed as a governed agent.** Runtime guardrails (ADR-0042) apply to the
copilot's inputs and outputs like any other agent — prompt-injection resistance matters especially
here because its context *is* the audit log and a crafted log entry is an injection vector. It is
enrolled in continuous red-teaming (ADR-0057): prompt-injection, data-exfil (can a malicious
record coax it into leaking another tenant's audit rows?), and PII-leak probes are part of its
regression suite, and a regression **blocks its promotion** through the same workflow gate as any
other model.

## Consequences

**Easier.** Natural-language governance analytics without an engineer in the loop — the compliance
officer's "who accessed PII last quarter" becomes a question, not a ticket. Because the copilot is
a governed tenant, it is also the sharpest possible dogfood: it exercises `executeGovernedDispatch`,
entitlement filtering, budget ceilings, audit, PII mode, guardrails, and red-teaming end-to-end,
on our own most sensitive data. If it is safe, that is strong evidence the kernel is. It reuses the
existing read layer (exports/reporting) and Approvals Queue rather than adding new privileged paths.

**Harder / explicitly given up.**

- **We gave up letting it act.** Read-mostly + approvals-for-everything is deliberately less
  magical than an agent that just fixes the policy for you. That friction is the point: an agent
  that could mutate governance from natural language is an ungoverned control-plane actor, and no
  amount of prompting makes that safe. The Approvals Queue detour is a feature, not a limitation.
- **Entitlement-scoped answers can mislead.** Because the copilot sees only what the caller may
  see, its answers are *partial by design* — "no PII access found" means "none in your scope," not
  "none anywhere." Answers must state their scope, or a scoped user will over-trust a narrow view.
- **The audit log is now an injection surface.** Feeding attacker-influenceable content (log
  `reason` strings, tool names, connector payloads that landed in the record) into an LLM invites
  prompt injection aimed at exfiltrating other rows or fabricating findings. Guardrails (ADR-0042)
  and red-teaming (ADR-0057) reduce but never eliminate this; the honest posture is that the
  copilot's outputs are drafts and leads requiring human verification, never authoritative
  attestations — which is also why it cannot act.
- **LLM analytics can be confidently wrong.** A drafted report or an anomaly flag can hallucinate
  a pattern or miscount. Grounding every answer in logged, structured tool queries (not free-form
  recall) and keeping a human sign-off on every report is the mitigation; the copilot accelerates
  the analyst, it does not replace them or their accountability.

**Follow-up work.** The read-only parameterized tool surface over the four ledgers, with
server-side entitlement filtering shared with ADR-0047. The Approvals-Queue item type carrying a
policy-as-code diff, and the writer that applies an approved diff under the *approver's* identity.
Enrollment in the ADR-0042 guardrail set and the ADR-0057 red-team suite with a promotion-blocking
regression gate. A precise statement, in-product, that copilot output is decision-support requiring
human sign-off — never an automated compliance determination.

## Amendment — 2026-08-02: implemented as a GOVERNED, GROUNDED RETRIEVAL LAYER with an unverified generation layer (migration 0072)

Implemented and accepted. What follows is the honest split between what this
release genuinely enforces and what is structural — and, before either, the
limit that shapes the whole thing.

### The correction this amendment makes, before anything else

**No model provider is connected in this build, so the copilot's GENERATION
quality is unverified and this release does not claim otherwise.** What ships,
and is tested, is everything up to and around the model: the natural-language →
structured-query step, the entitlement-scoped retrieval, the grounded answer,
the guardrail pass over untrusted ledger text, the proposal path, and the audit
trail. The model call itself follows ADR-0044's judge pattern exactly — an
interface (`CopilotNarrator`), a model-backed implementation
(`ModelBackedNarrator`) that dispatches through `executeGovernedDispatch`, and a
test seam — and has never narrated real evidence. Every answer object carries
`modelNarrationVerified: false`, and `POST /v1/copilot/ask` says so in its own
response.

**The NL step is deterministic code, not a model call, and that is a design
decision rather than a shortcut.** `planCopilotQuery` reads only the USER'S
QUESTION and can emit exactly one of four bounded tool calls. That buys three
things worth more than fluency: the retrieval path is testable with no provider;
a crafted audit-log entry cannot steer the planner, because the planner never
reads retrieved data; and the answer is composed from COUNTS, so the grounded
layer structurally cannot hallucinate a figure. A model narration, when a
provider is connected, is layered on top — never a replacement.

### Genuinely enforced by this release

- **It cannot read what its invoking user cannot — at the query boundary.**
  `resolveCopilotScope` turns the caller into a concrete project-id list using
  ADR-0047's own `callerProjectIds`, and every `SELECT` is built with that list
  in its `WHERE` at construction. The suite seeds team B's audit rows with a
  distinctive marker, has team A's lead ask a question whose unscoped answer
  would include them, and asserts the marker is absent from the answer, absent
  from the **retrieved evidence set**, and absent from the stored row — with the
  count equal to team A's two rows rather than the sum of eight. An admin's
  identical question **is** asserted to see the sum, so the narrowing is a
  narrowing and not an empty ledger.
- **There is no privileged copilot identity.** An identity-less caller — the
  bootstrap token, which is otherwise fully admin — is refused with 403 and an
  audited deny, because there is no entitlement set to inherit. A non-admin sees
  only their own questions and their own proposals.
- **The narrator is a tenant, not an exemption.** Narrating with a registry
  agent the invoking user may not invoke is refused 403 through the ordinary
  `evaluateAgent` path with an audited deny; once granted, the same call
  dispatches through `executeGovernedDispatch` and the suite asserts a new
  `usage_events` row attributed to that user and that project. The copilot has
  no private budget and no private ledger.
- **It has no mutating tools.** Four read tools, enumerated and self-describing
  at `GET /v1/copilot/tools` with `mutatingTools: []`. A proposal writes a
  `copilot_proposals` row plus **one ordinary `approvals` row** and the suite
  asserts the grant and role tables are byte-for-byte unchanged across it.
  Migration 0072 contains no column naming a grant, role, rule or entitlement to
  change. Building a proposal on **another user's query** — laundering
  wider-scoped evidence into your own hands — is refused and audited.
- **The audit log is treated as an injection surface.** Retrieved `reason`
  strings pass through ADR-0042's guardrails as phase `input` before they reach
  a model or an answer; with the org detector at `block`, the suite asserts the
  samples are **withheld**, the counts survive (the grounded answer is built from
  them), `copilot_queries.guardrail_action` records `block`, and the hit is
  audited.
- **An ungrounded narration is discarded, not merged.** `narrationIsGrounded`
  cross-checks the narration's own cited count keys against the retrieval's; a
  narration citing a figure that was never produced is thrown away, the grounded
  answer stands alone, and the discard is audited. There is no path on which
  model prose replaces the counts.
- **Answers state their scope.** `COPILOT_SCOPE_CAVEAT` is a field on every
  answer: a zero means "none in your scope", never "none anywhere". Every answer
  also carries `COPILOT_DECISION_SUPPORT_NOTICE` — decision support, never an
  automated compliance determination.
- **Everything is audited** with stable rule ids: the question (with the exact
  scope its retrieval was narrowed to), the guardrail action, the proposal, and
  the four refusals (no identity, narrator not entitled, narration discarded,
  proposal evidence not yours).

### Structural only — named plainly

- **Generation quality, as above.** Unverified. `ModelBackedNarrator` has never
  run against a real provider.
- **An approved proposal is not applied by anything.** §"Follow-up work" names
  "the writer that applies an approved diff under the approver's identity". That
  writer **is not built**. A proposal opens an approval carrying the diff; a
  human approving it changes nothing automatically today. This is deliberate for
  a first release — an auto-applier is a privileged mutation path and deserves
  its own design — but it does mean the §"worked example" loop stops at
  "approved", not at "revoked".
- **The four capabilities are unequal.** Natural-language querying, anomaly
  *leads* and the proposal path are real. **Report drafting is not built here**:
  the copilot does not call ADR-0047's report generator or ADR-0058's pack
  evaluator on the user's behalf. Those are separate endpoints a human drives.
- **Anomaly detection is two heuristics, not a model.** Deny bursts by rule, and
  approvals decided in under two seconds. Both are leads with their evidence
  attached, and both are deliberately crude; pillar 5's own forecast/anomaly
  engine (ADR-0049) is not wired in here.
- **The planner is a phrase classifier.** It handles the ADR's worked questions
  and says `fallback: true` when it matched nothing rather than guessing. It
  does not parse dates, entities, or named users. A richer planner is a natural
  place to put a model call later — behind the same interface, with the same
  bounded output type.
- **Not enrolled in red-teaming.** §5's "enrolled in continuous red-teaming
  (ADR-0057) with a promotion-blocking regression gate" is not wired; ADR-0057
  landed alongside this and the enrollment is follow-up work.
- **Evidence is bounded to five samples.** Deliberate — samples are the
  injection surface — but it means the copilot's qualitative view of any window
  is shallow.

### Migration

`0072_governance_copilot.sql` — two tables: `copilot_queries` (the question, the
structured plan, the retrieved evidence, the grounded answer, the guardrail
action, and `scope_project_ids` — the exact set the retrieval was permitted to
touch, which is what makes containment auditable forever) and `copilot_proposals`
(a diff plus the evidence that justifies it, bound to an ordinary `approvals`
row). `audit_log.object_type` gains `copilot_query` and `copilot_proposal`, and
`approvals.object_type` gains `copilot_proposal`, both as TS-only widenings —
neither column has a DB CHECK, so there is no DDL for them.

## Amendment — 2026-08-22: THE COPILOT GOES LIVE (L6a/L6b, migration 0100)

The 2026-08-02 amendment named two structural gaps in its own words. Both are
now closed, and this amendment is a **delta** — everything the first amendment
recorded still stands except where contradicted below.

### The correction this amendment makes, before anything else

**"No model provider is connected in this build" is no longer true, and the
release no longer says it is.** A live Google/Gemini credential exists (the
2026-08-21 unparking, `docs/product/LIVE_VERIFICATION_2026-08.md`), and the
copilot's narration path has now run against a real model through
`executeGovernedDispatch` — platform env credential, the caller's entitlements
deciding, tokens metered into `usage_events` and billed to a named project.

Two consequences the honesty discipline forces:

- **`modelNarrationVerified` is no longer a build-wide constant `false`.** It
  is a per-answer boolean and it means exactly one thing: *this* narration was
  cross-checked against *this* retrieval's counts and object ids and passed.
  It is never a claim that the model is generally reliable. A discarded
  narration leaves it `false`, and a grounded-only answer leaves it `false`
  because no model was called.
- **`POST /v1/copilot/ask`'s `note` is now three different sentences** — model
  narration cross-checked / narration attempted and discarded / no narrator
  named. The old single note asserted a fact about the build; these assert
  facts about the answer in hand.

### L6a — grounding is now BY RETRIEVED OBJECT ID, and an empty retrieval REFUSES

The first amendment grounded answers in **counts**. Counts cannot be
hallucinated, but they also cannot be walked back to rows, and they say nothing
about the case that matters most: a question whose retrieval found *nothing*.

- **`CopilotEvidence.citableObjects`** — every retrieval now returns the
  concrete governance objects it selected, by primary key
  (`audit_log` / `approval` / `usage_event`), from the SAME scoped `WHERE` the
  counts came from. The label is gateway-written fact (`effect · ruleId`),
  never the attacker-influenceable `reason` string, which stays in the
  guardrailed sample channel.
- **`narrationIsGrounded` gained the object-level check.** A narration citing
  an id the retrieval never returned is discarded exactly like an invented
  figure. A count key is a shape the renderer owns; an object id is a claim
  that a row exists, so an unretrieved id is either a hallucinated record or an
  id the model was fed by crafted ledger text — the same failure either way.
- **The grounded refusal.** `retrievalFoundNothing` (no citable object AND no
  matched row) makes the answer a REFUSAL with a fixed shape
  (`COPILOT_GROUNDED_REFUSAL`, `groundedRefusal: true`). The narration prompt
  carries the matching hard rule, and a narration that answered anyway over an
  empty retrieval is DISCARDED with the grounded refusal standing. A zero
  COUNT is still an answer ("0 denials in your scope"); an EMPTY RETRIEVAL is
  not, and the two are distinguished in code, in the payload and on the page.
  The refusal is deliberately phrased as scope ("no matching record in your
  scope"), never as "no such thing exists" — a scoped read cannot support that.

### L6b — an approved proposal CAN now be applied, and only an approved one

`POST /v1/copilot/proposals/:proposalId/apply` (admin, internal, tagged
`copilot` in the ADR-0053 registry). The first amendment's "an approved
proposal is not applied by anything" is closed for the kinds whose change has a
**public choke point an admin would use by hand**, and deliberately NOT closed
for the others.

- **Consent is the gate, and it is the ONE queue.** The status of the LINKED
  `approvals` row decides. `pending` and `denied` refuse `proposal_not_approved`
  naming the status; a proposal with no approval refuses
  `proposal_has_no_approval`; a deleted queue row refuses
  `proposal_approval_missing`. Every refusal is audited as a deny and the
  target is asserted unchanged.
- **Through the public door, never past it.** `grant_revocation` rides the
  one-per-kind removal in `grant-revocation.ts` — the exact function
  `DELETE /v1/grants/…` and an ADR-0090 campaign's revoke decision call.
  `policy_tightening` rides `applyRuleEdit`, ADR-0074's single door, so a
  versioned rule mints and activates a version instead of silently drifting;
  the choke point's own refusal (e.g. `unresolvable`) is surfaced verbatim
  rather than worked around. There is no raw table write in the handler.
- **Attributed to the human.** The audit row is written under the applying
  admin's identity with the proposal as context — proposal id, query id,
  proposer, the diff, and what the choke point reported back.
- **Once.** `copilot_proposals.applied_at` is the idempotency gate; a second
  apply refuses `proposal_already_applied` rather than re-executing a mutation.
- **A malformed diff refuses** (`proposal_diff_invalid`) before anything is
  attempted, so a proposal can never be half-applied.

**Named unapplied, with the endpoint that must exist first** (in
`COPILOT_UNAPPLICABLE_PROPOSAL_KINDS`, returned verbatim in the 422):
`rule_to_approval` needs a cross-artifact CREATE (a new `approval_rules` row
derived from a rate-limit/data-scope rule) that no endpoint performs —
`applyRuleEdit` edits an artifact that exists, it does not mint one of another
type; `budget_adjustment` has no single choke point comparable to
`applyRuleEdit` (project budget, compliance-profile ceiling and virtual-key cap
are three surfaces with three governance stories). Reaching past a missing
endpoint to write the row would be exactly the ungoverned control-plane
mutation this ADR exists to prevent, so both refuse by name.

> **Superseded 2026-08-22 (batch B8c).** Both kinds now apply through public
> choke points and `COPILOT_UNAPPLICABLE_PROPOSAL_KINDS` is empty — see the
> B8c amendment below, which also records why the "no endpoint performs it"
> reading above was too pessimistic for both kinds.

### Non-vacuity (M-002 — every count MEASURED by running the probe, then reverted by exact Edit reversal)

- **Empty the grounding retrieval** (`base.citableObjects = []` in
  `retrieveEvidence`): **2 gateway tests redden** — "cites the REAL ids of the
  rows its own scoped retrieval returned" and "ACCEPTS a grounded narration,
  marks it verified". Recorded honestly: the *refusal* test stays green under
  this probe, because emptying the retrieval makes MORE things refuse. The
  refusal assertion is therefore guarded by its CONTROL (the positive citation
  test), which is what this probe reddens.
- **Make the refusal condition never fire** (`retrievalFoundNothing` returns
  `false`): **3 shared tests redden** — the refusal renderer, the prompt's
  refusal instruction, and the narration refusal cross-check. This is the probe
  that proves the refusal assertions themselves bite.
- **Drop the approval-status check in apply** (`if (false && …)`): **2 gateway
  tests redden** — refuses-PENDING and refuses-DENIED, both of which then apply
  the mutation they exist to prevent.

### Honest limits after this amendment

1. **One live model, one run.** The narration path is verified against
   Google/Gemini (`gemini-3.6-flash`). Other providers' adapters remain
   fake-server-proven; "the model obeys the grounding contract" is a measured
   fact about this model on these prompts, not a general property.
2. **Output ceilings are a real failure mode, and were measured as one.** The
   narrator's original 1024-token ceiling made narration IMPOSSIBLE on a
   reasoning model: the reply came back `finishReason: MAX_TOKENS` after 981
   thought tokens and 39 tokens of JSON, and was correctly discarded as
   unparseable. Re-running the identical prompt at 4096 finished cleanly
   (`STOP`, 1688 thought tokens, complete JSON citing the real object ids) —
   which is what proves the ceiling was the cause. The ceiling is now 4096.
   A future model with a larger thinking budget can reintroduce this, and the
   symptom will again be a discarded narration, not a wrong one.
3. **The grounded refusal is verified on ONE nonsense question.** The live
   model refused an invented object cleanly; that is evidence, not a guarantee
   that no phrasing can coax an answer out of an empty retrieval. The
   structural protection is the cross-check, which discards such an answer
   whether or not the model behaves.
4. **Two of four proposal kinds are unapplied**, as above. — **Closed
   2026-08-22 (batch B8c), see the B8c amendment below.**
5. **The applier is not transactional across the audit row.** The choke point
   executes, then the proposal row is stamped, then the audit row is written.
   A crash between them leaves an applied change with `applied_at` unset — the
   choke point's OWN audit row (e.g. `copilot-proposal-rule-edit`) still
   records the change, so nothing is invisible, but the proposal would read as
   unapplied and a retry would re-execute.
6. **Still not enrolled in red-teaming** (§5's promotion-blocking regression
   gate). Unchanged from the first amendment.

### Migration

`0100_copilot_apply_and_judged_recommendations.sql` — `copilot_proposals` gains
`applied_at` / `applied_by_user_id` / `applied_result`, all NULL for every
existing row (which is exactly their pre-L6 state). No backfill, no new table.

## Amendment — 2026-08-22 (L6d): THE UNFILTERED-SUBJECT HALLUCINATION, found live and closed in two layers

This amendment exists because the L6a amendment above was **wrong about how much
it had closed**, and a hands-on session found the hole the same day. No
migration; code and contract only.

### The defect, as found

Reproduced against a live narrator on the coordinator's own instance:

```
POST /v1/copilot/ask   (admin caller, live Google/Gemini narrator)
{"question":"Summarise the Zorblatt Quantum Compliance Widget approvals from last week",
 "narratorAgentId":"<google agent>"}
```

There is no Zorblatt Quantum Compliance Widget. There never was. The keyword
planner matched only `"approval"` and `"last week"`, ran **`listApprovals` with
no entity filter at all**, retrieved **eight real, unrelated, org-wide
approvals**, and the model narrated:

> *"Over the last 7 days **for the Zorblatt Quantum Compliance Widget
> approvals**, 8 approvals were requested, 4 approvals were in state 'approved',
> and 4 approvals were in state 'pending'."*

`groundedRefusal: false`. Five real approval ids cited. And
**`modelNarrationVerified: true`.**

For a governance product this is the exact hallucination class the copilot
claims to prevent — real records confidently attributed to a subject nobody ever
searched for — and the verification flag made it worse by stamping a false
statement as checked.

### Why all three existing guards missed it, precisely

Each of them passed *correctly*. That is the point: they were never asked this
question.

| Guard | Why it passed |
| --- | --- |
| `retrievalFoundNothing` → grounded refusal | The retrieval was **not** empty. Eight real rows, five citable objects. The refusal fires only on an empty read; this read was full. |
| Figure cross-check (`citedKeys`) | Every figure the model used — 8, 4, 4 — was a count the retrieval actually produced. Nothing was invented. |
| Object-id cross-check (`citedObjectIds`) | Every id cited was a primary key this caller's own scoped query returned. Nothing was invented. |

All three verify that **what the answer says is drawn from the retrieval**.
Not one of them asks whether **the retrieval was about what the question
asked**. Grounding was checked *downstream* of the plan and never *against* it,
so a plan that quietly dropped the subject was invisible to every check.

### The fix — two layers, because a prompt rule alone is wishful thinking

**Layer 1 — the model can now see what was filtered on.**
`buildNarrationPrompt` never showed the plan's `params`. It showed the QUESTION
and it showed the ROWS, and nothing that said the rows had not been narrowed to
the thing the question named — so "these approvals are the Zorblatt ones" was
the only reading available. The prompt now carries a `FILTERS:` line rendering
`plan.params`, and when there are none it says so outright: *"FILTERS: none —
these are ALL `listApprovals` records in the caller's scope for the period,
narrowed by nothing else. They are NOT about any subject named in the
QUESTION."* A new **hard rule 6** requires the findings to be described in terms
of the tool and filters actually executed, forbids attributing them to any
entity that appears in neither FILTERS nor the RETRIEVED GOVERNANCE OBJECTS,
states that *the question is a request, not evidence that its subject was
searched for*, and requires one clause saying so when the subject was not
filtered on.

**Layer 2 — a deterministic caveat that does not depend on the model obeying.**
This is the layer that holds when the narration misbehaves, and it follows
`COPILOT_SCOPE_CAVEAT`'s reasoning exactly: the honest qualification on an
answer is emitted by code that cannot decline to emit it.

- `GroundedAnswer` gains two siblings of `scopeCaveat`/`notice`:
  **`subjectFiltered`** (did the executed plan narrow at all?) and
  **`unfilteredSubjectCaveat`** (the sentence, non-null exactly when it did
  not).
- Every answer's grounded text now renders `Filters applied: …` — *none*
  included — and, when there are none, the caveat sentence itself. Because the
  grounded text is handed to the narrator as **authoritative**, layer 2 also
  strengthens layer 1.
- The `POST /v1/copilot/ask` `note` leads with the caveat when the query
  narrowed on nothing, and the `copilot-question-answered` audit row records
  `filters` and `subjectFiltered` — so *"was that answer actually about the
  thing I asked?"* stays answerable from the ledger after the prose is gone.
- The copilot page badges it (`no filter — every record in scope`) and prints
  the caveat next to the scope caveat.

### What `modelNarrationVerified: true` means, and what it does NOT

Deliberately **unchanged**, and documented instead of widened. It means exactly:

> *This* narration's cited count keys and cited governance-object ids were all
> checked against *this* retrieval and were all things the retrieval actually
> produced.

It does **not** mean the narration is correct, does **not** mean the model is
reliable, and — the L6d lesson — does **not** mean **the answer is about what
you asked**. Real figures over an unfiltered query can still be narrated as
belonging to a subject nobody filtered on, and that answer is `verified: true`
because the figures really were real.

The alternative was to flip the flag to `false` in this situation. Rejected, for
two reasons. First, it would silently change what `true` means on every *other*
answer, from a checkable provenance claim into a vague quality claim. Second, it
would make the flag depend on a keyword guess about which words in a question
are "the subject" — a second heuristic of exactly the kind that caused this
defect, and one that would fail closed on some questions and open on others with
no way to tell which. A verification flag whose meaning cannot be stated in one
sentence is worse than no flag. So the flag keeps its narrow, true meaning; the
separate fact rides `subjectFiltered`, the caveat, the badge, the note and the
audit row.

### Non-vacuity (M-002 — every count MEASURED by running the probe, then reverted by exact Edit reversal)

- **Remove the caveat emission** (`unfilteredSubjectCaveat` forced to `null`,
  the `lines.push` dropped): **1 shared test + 1 gateway test redden** — "carries
  the unfiltered-subject caveat as a FIELD and in the answer TEXT" and "a
  question naming an entity nobody filtered on carries the unfiltered-subject
  caveat". Recorded honestly: the two CONTROL tests stay green under this probe,
  because they assert the caveat's *absence* — that is what makes them controls.
- **Remove the `FILTERS:` block from the prompt**: **2 shared tests redden** —
  the no-filter disclosure and the rendered-params disclosure. Both layers are
  therefore separately load-bearing.
- **Remove hard rule 6** (replaced with placeholder text): **1 shared test
  reddens** — the rule-text assertion, including its check that the JSON-shape
  rule survived renumbering to 7.

### Live re-check — the same question, the same shape, a different answer

Same question, same plan (`listApprovals`, `params: {}`), eight real approvals,
five real cited ids, `modelNarrationVerified: true`, `groundedRefusal: false` —
every input to the original failure held constant. The narration, verbatim:

> *"This summary is scoped to the caller's own entitlements. Based on the
> listApprovals tool executed for the last 7 days with no filters applied
> (across all records in scope, not only Zorblatt Quantum Compliance Widget), 8
> approvals were requested in total, with 4 in state 'approved' and 4 in state
> 'pending'."*

The model took hard rule 6's own escape clause. That is evidence the prompt
layer works on this model; it is **not** a guarantee, which is why layer 2
exists and why the committed tests assert layer 2 rather than the prose.

### Honest limits after this amendment

1. **The planner is still keyword-based, and an unknown entity is IGNORED
   rather than narrowing the query.** This amendment makes the copilot *say* it
   did not filter on the subject. It does not make it filter on the subject, and
   it does not detect that "Zorblatt Quantum Compliance Widget" is a subject at
   all. A question about a real vendor that the planner has no filter for gets
   the same treatment as one about a fictional widget: honest, and unhelpful.
   **Entity-aware planning — resolving named entities against the governed
   object graph and either filtering on them or refusing — is a separate, larger
   slice**, tracked in `docs/product/PENDING.md`.
2. **`subjectFiltered: true` does not mean "narrowed to your subject".** The
   current param vocabulary (`effect`, `objectType`, `status`) contains **no
   true entity filter** — nothing in it can narrow to a named product or vendor.
   So `true` means "the query narrowed by something", which is the closest
   available proxy and is stated as such rather than dressed up. The control in
   the committed suite pins the proxy's behaviour; it does not pretend the proxy
   is the real thing.
3. **The caveat is a statement about the plan, not about the question.** It is
   deliberately not gated on "did the question name something we did not
   filter on", because answering that needs the entity resolution of limit 1.
   The consequence is that a genuinely org-wide question ("how many approvals
   last week?") also carries the caveat. That is true, mildly noisy, and the
   right side to err on.
4. Limits 1–6 of the L6a/L6b amendment stand unchanged.

---

**2026-08-22 — the L6d residual above is CLOSED by
[ADR-0096](0096-entity-aware-copilot-planning.md).** Honest limit 1 ("the planner is still
keyword-based, and an unknown entity is IGNORED rather than narrowing the query") and limit 2
("`subjectFiltered: true` does not mean 'narrowed to your subject'") are superseded there.
Entity-aware planning now extracts candidate subjects deterministically, resolves them against
the governed object graph under the caller's own entitlements, and takes one of three named
refusals — unresolved, ambiguous, or resolved-but-this-tool-cannot-filter-that-kind — rather than
running broad and caveating. The Zorblatt question in this amendment REFUSES as of ADR-0096; it
is no longer answered at all. **The caveat machinery this amendment introduced is kept, not
deleted**: `subjectFiltered` and `unfilteredSubjectCaveat` now cover the narrower case ADR-0096
does not touch — a question that names no subject the extractor could see, whose broad answer
must still say it is about nothing in particular. Limits 3 and 4 above stand unchanged.

## Amendment — 2026-08-22 (batch B8c): the two honestly-unapplied proposal kinds APPLY, through routes that already existed

L6b left `rule_to_approval` and `budget_adjustment` refusing with "the endpoint
that must exist first is X". This amendment closes both — and the honest
finding is that **neither needed a new endpoint built**. Both refusal texts
were too pessimistic, in the same way:

- `rule_to_approval` claimed "no endpoint performs the cross-artifact CREATE".
  But the cross-artifact work decomposes: the *derivation* (reading the noisy
  rate-limit/data-scope rule and deciding an approval requirement should exist)
  happened at PROPOSAL time and lives in the proposal's evidence; the *apply*
  half is nothing but creating an `approval_rules` row — which
  `POST /v1/rules/approvals` has performed since pillar 1.
- `budget_adjustment` claimed "three surfaces with three governance stories" and
  no single choke point. But the kind's own diff has always named a
  **`projectId`** — a budget_adjustment proposal is a PROJECT-budget adjustment
  (the object pillar 5 attributes spend to), and the project budget has exactly
  one public write: `PATCH /v1/projects/:projectId`. A compliance-profile
  ceiling is a rule artifact and already rides `policy_tightening`; a
  virtual-key cap is not a project budget and stays out of this kind's scope —
  scoping stated here rather than smuggled.

### Per kind: the route, and how the applier rides it

**`rule_to_approval` → `POST /v1/rules/approvals` (pre-existing; its create
extracted, not rebuilt).** The route's inline insert moved to
`createApprovalRuleRow` (`apps/gateway/src/rule-creates.ts`, the exact pattern
`grant-revocation.ts` set): the admin route and the applier now share ONE
implementation, byte-identical route behaviour. The applier: (1) parses the
diff shape (`copilotRuleToApprovalDiffSchema`: `{sourceRuleKind ∈
{rate-limits, data-scopes}, sourceRuleId, create}`); (2) runs the ROUTE'S OWN
`createApprovalRuleSchema` — including its scope superRefine and its
scope/serverScope defaults — over `create`, refusing `proposal_diff_invalid`
with that schema's issues verbatim; (3) refuses `proposal_target_gone` (404)
when the SOURCE rule no longer exists, because a conversion derived from a
deleted rule is a requirement justified by nothing; (4) creates through
`createApprovalRuleRow`. The `rule-write-guard.test.ts` AUDITED_WRITERS entry
moved with the insert (`app.ts` → `rule-creates.ts`), reason updated — the
enumerated-writer set still has no new writer, only a relocated one.

**`budget_adjustment` → `PATCH /v1/projects/:projectId` (pre-existing; its
handler core extracted, not rebuilt).** The handler moved to
`applyProjectPatch` (exported from `apps/gateway/src/projects.ts`): merge over
the current row, re-check budget-requires-approver against the MERGED row,
write, audit `project-updated` — the route now calls it with byte-identical
responses (the 404 still carries no detail). The applier: (1) parses the diff
shape (`copilotBudgetAdjustmentDiffSchema`: `{projectId, patch}`); (2)
restricts the patch's KEYS to `COPILOT_BUDGET_ADJUSTMENT_FIELDS` (`budgetUsd`,
`budgetApproverUserId`, `budgetPeriod`, `alertThresholdPct`) — a
budget_adjustment may not rename or re-parent a project; (3) runs the ROUTE'S
OWN `updateProjectSchema` over the values, refusing with its issues verbatim;
(4) calls `applyProjectPatch`, surfacing ITS refusals verbatim —
`unknown_project` (the target vanished) and `budget_requires_approver` (the
route's own invariant) are the same answers an admin's own PATCH gets. The
`project-updated` audit row — the route's own rule id — is stamped with
`copilotProposalId`/`approvalId` via the same `auditDetail` courtesy
`applyRuleEdit` extends, so the change is visible as an ordinary project edit
AND traceable to the proposal.

### Parity tests (zz-zz-copilot-live.test.ts, mirroring the existing kinds)

`rule_to_approval`: pending → `proposal_not_approved`, nothing created, audited
deny; approved apply → 200, the approval rule EXISTS with the route's fields,
`applied.via` names the route, `applied_at`/`applied_by_user_id` set, audited
under the applying admin with the proposal as context; second apply → 409
`proposal_already_applied`, still exactly one rule; source rule deleted (via
the ordinary `DELETE /v1/rules/rate-limits/:id`) → 404 `proposal_target_gone`,
nothing created; a `create` the route's zod refuses (scope 'user', no userId)
→ `proposal_diff_invalid` naming `createApprovalRuleSchema` and carrying its
message verbatim, nothing created.

`budget_adjustment`: approved apply → 200, the project row's `budgetUsd` MOVED,
the `project-updated` audit row carries the proposal id and the changed set,
the applier row is under the admin's identity; denied → `proposal_not_approved`,
budget unchanged; second apply → 409 and does NOT re-execute (an admin moves
the budget by hand between the two applies and the manual value survives);
unknown project → the route's own `unknown_project` 404, unapplied; a negative
budget → `proposal_diff_invalid` naming `updateProjectSchema`, unchanged; a
budget on a project with no approver → the route's own
`budget_requires_approver` 422 verbatim, unchanged; a patch smuggling `name` →
`proposal_diff_invalid` ("'name' is not a budget field"), name and budget both
unchanged.

### Non-vacuity (M-002 — every count MEASURED by running the probe, then reverted by exact Edit reversal)

- **Disable the source-rule existence check** (`if (false && !source)`):
  **1 gateway test reddens** — "refuses … whose SOURCE rule vanished".
- **Disable the budget-fields restriction**: **1 gateway test reddens** — "a
  budget_adjustment may not rename a project". Recorded honestly: the
  `keys.length === 0` half of that condition has no dedicated test — an empty
  patch would in any case be refused one line later by `updateProjectSchema`'s
  own "nothing to update" refine, so the early check is a better message, not
  the only guard.
- **Bypass `updateProjectSchema`** (feed the raw patch through): **1 gateway
  test reddens** — the budget zod-bypass test, which then APPLIES a negative
  budget the route would have refused.
- **Bypass `createApprovalRuleSchema`**: **3 gateway tests redden** — the
  zod-bypass test AND both positive rule_to_approval tests, because the
  route's schema also supplies the scope/serverScope defaults the create
  depends on. The route's zod is load-bearing for the happy path, not only for
  refusals — one more reason the applier must never skip it.

### Disclosures removed

- `COPILOT_UNAPPLICABLE_PROPOSAL_KINDS` is now `{}` (the constant and the
  fallback refusal stay, for the next kind that lands
  proposed-before-appliable); `COPILOT_APPLICABLE_PROPOSAL_KINDS` lists all
  four kinds; the doc comments at both sites restated.
- The stale "Named unapplied" paragraph and honest-limit 4 of the L6a/L6b
  amendment above carry dated supersession notes pointing here.
- The applier's route doc-comment and the live-test header no longer claim a
  kind without a door exists today.
- The ADR index row (README.md) is updated alongside this amendment.
- **Not editable by this batch** (shared-ledger ownership, batch rules):
  `docs/product/PENDING.md` line "rule_to_approval and budget_adjustment stay
  unapplied and named" and `project-state/STATE.md`'s "two kinds honestly named
  unapplied" recap sentence are now stale and need a one-line touch-up by the
  ledger owner.

### Honest limits after this amendment

1. The applier is still not transactional across its audit row (L6a/L6b limit
   5, unchanged; the two new kinds share the same shape — choke point, then
   `applied_at`, then audit).
2. `rule_to_approval` CREATES the approval requirement; it does not retire the
   source rule. "Convert" as delete-and-replace was deliberately not invented
   here: the proposal's diff carries only a `create`, and removing a
   rate-limit/data-scope rule is its own governed act (`DELETE
   /v1/rules/:kind/:ruleId`) a human can take — or a future proposal kind can
   propose — separately.
3. `budget_adjustment` is scoped to PROJECT budgets, as stated above. A
   proposal wanting to move a compliance-profile ceiling must be a
   `policy_tightening` on that profile; a virtual-key cap has no proposal kind.
4. All other limits of the earlier amendments stand unchanged.

No migration: `copilot_proposals` (0100) and both target tables already carry
every column this needed. Migration 0103 was reserved for this batch and is
deliberately NOT used.

---

## Amendment — 2026-09-27 (batch B9a): consent is never asked for a diff that cannot be applied, and the propose half gets a UI

### The correction this amendment makes, before anything else

The B8c amendment above closed "an approved proposal is not applied by
anything" and reported the loop complete. It was not. Two things were missing,
and the first is a governance defect rather than a gap:

**Diff validation lived in the APPLIER only.** `POST /v1/copilot/proposals`
parsed `copilotProposalSchema` — which types `diff` as `z.record(z.unknown())`
and therefore accepts any object at all — and then wrote the proposal row AND
an ordinary `approvals` row. The per-kind diff schemas ran at apply time. So a
malformed diff was recorded, a real Approvals-Queue item was opened, a named
human read a title and a rationale and consented, and only then did the product
answer `proposal_diff_invalid`.

That leaves a **real human approval permanently on the audit record against a
change that could never happen**. In a product whose entire claim is that
consent is traceable, that is the worst possible place to discover a validation
error: the ledger now holds a person's recorded approval of nothing, and it
cannot be distinguished later from an approval of something real that was never
applied.

The evidence that this was not theoretical: the existing test in
`apps/gateway/src/copilot.test.ts` proposed `diff: { revoke: [{ userId,
toolName }] }` — a shape no applier branch can read — and asserted **201**. The
test had to be changed by this batch, which is the clearest possible statement
of what was wrong.

### Decision

**1. One authority on diff validity, called from both ends.**
`validateCopilotProposalDiff(kind, diff)` (`apps/gateway/src/copilot.ts`) is
now the only place that decides whether a diff is well-formed. The propose
route calls it and refuses `422 proposal_diff_invalid` with an audited deny
**before any approval row exists**; the applier calls the same function and the
four inline copies of that parsing are gone from it.

The applier's call is **not redundant**. Rows proposed before this existed are
still in the table, and a nested payload schema can tighten after a proposal is
recorded. Defence in depth at a mutation door is not a duplication worth
trading away — but two *different* implementations of the same check would
have been, which is why this is one function rather than two.

**What it checks:** shape (the four `.strict()` per-kind diff schemas), the
nested payload schemas of the two kinds that carry one
(`createApprovalRuleSchema`, `updateProjectSchema` — the exact zod the public
routes parse with, never a copy), and `budget_adjustment`'s key restriction to
`COPILOT_BUDGET_ADJUSTMENT_FIELDS`, which is structural.

**What it deliberately does not check:** that the target still exists. A grant,
rule or project can be removed between proposing and applying; that is a fact
about the world at apply time, not a defect in the diff. Enforcing it at
propose time would also make a proposal expire silently. Those checks stay
where they can only be answered — in the applier, against the database, at the
moment of the write. A test pins this: a `grant_revocation` naming a grant id
that does not exist is **recorded** (201), and refused at apply with
`proposal_target_gone`.

**One new refusal:** a `policy_tightening` whose `patch` is `{}`.
`applyRuleEdit` treats an empty patch as a no-op, so without this an approver
could consent to a "tightening" that moves nothing and the proposal would then
record itself as applied.

**2. The propose half gets a UI.** Before this batch the copilot page could
LIST proposals and APPLY approved ones, but there was no form — so the
product's single most governed write was the one an admin could not reach
without curl, and the four accepted diff shapes were documented nowhere a user
could see them. `apps/web/src/views/admin/governance/CopilotProposalForm.tsx`
covers all four kinds, and its shape follows from point 1:

- **The target is chosen from the real object, never typed.** A grant comes out
  of that user's or that role's own entitlement list carrying its real grant
  id; a rule out of that kind's rule table; a project out of the project list.
  A retyped uuid is the most likely cause of a refused proposal, and there is
  no text box here for one to be retyped into. Role-conferred entitlements are
  excluded from the per-user grant kinds, with the reason stated on screen,
  because they carry no grant row to remove.
- **A patch names only what moves.** Both `applyRuleEdit` and `PATCH
  /v1/projects/:projectId` take a partial patch, so each editable field has its
  own inclusion toggle and shows the current value either way: absent is not
  the same as set to what it already is, and an admin who cannot see the
  current value cannot tell a tightening from a loosening.
- **A derived rule inherits its scope.** A `rule_to_approval`'s `create` takes
  subject, server and deploy binding from the source rule rather than asking
  for them again — a requirement "derived from" a rule that binds different
  subjects is not derived from it, and those six fields are exactly where
  `createApprovalRuleSchema`'s `superRefine` would otherwise fire.
- **The diff is rendered before it is sent**, and a refusal is shown verbatim
  (the gateway's sentences name the enforcing schema). The recorded object is
  what a named human will be asked to approve; a proposer who has not read it
  is asking someone else to consent to something they did not read either.

`AskResponse` in `CopilotPage.tsx` gained the `query` field the ask endpoint has
always returned (`copilot.ts` strips only `evidence`). The interface simply
never declared it, which is why the page could not offer to propose from an
answer at all.

### Consequences

- A proposal and its approval now stand or fall together: no approval is opened
  against a diff the applier would refuse. The reverse is still possible and
  still correct — an approved proposal whose target vanished refuses at apply
  with `proposal_target_gone` and stays unapplied.
- `scripts/preflight-ui-affordances.mjs`'s add-affordance list drops from two
  entries to one: `/v1/copilot/proposals` is closed, `/v1/redteam/libraries`
  remains. **Correction (same day):** the first version of this paragraph, of the
  index row, and of `STATE.md`'s recap all said "0 add gaps". That was wrong — I
  read the census output as though closing the copilot entry emptied the list,
  and `/v1/redteam/libraries` was printed directly beneath it. Two delete orphans
  also remained at that point (`/v1/approvals/views/:x`,
  `/v1/llm/backend-configs/:x`); the first is closed by batch B9b.
- Tests: the four apply-time refusal assertions in
  `zz-zz-copilot-live.test.ts` moved to propose time, each now also asserting
  that **no approval row was opened** — the half a status-code check misses. One
  new test inserts a pre-gate row directly and asserts the applier still
  refuses it, which is the only path that can now reach that code. New e2e
  `apps/web/e2e/zz-zz-zz-zz-zz-zz-zz-zz-zz-zz-zz-copilot-propose.spec.ts`
  compares the previewed JSON byte-for-byte against the diff the server
  recorded, because a preview that drifts from the payload is worse than no
  preview.

### Honest limits after this amendment

1. The form covers the four kinds that exist. A fifth proposal kind needs a
   builder here as well as an applier branch, and nothing enforces that pairing
   — the affordance census would catch a missing form only if the kind also
   introduced a new route.
2. Diff validity is not target validity, by design (see above). A proposal can
   still be approved and then refused at apply because the world moved. The
   proposals table shows `appliedAt` but does not yet surface "approved, and
   would now fail" — an admin learns it by clicking Apply.
3. The propose-time check cannot validate what only the database knows: a
   `policy_tightening` patch is checked against the rule kind's field list at
   apply (`validateRuleVersionBody` inside `applyRuleEdit`), not here, because
   that authority lives behind the choke point and duplicating it would be the
   second source of truth this amendment exists to avoid.
4. All limits of the earlier amendments stand unchanged.

No migration: every column this needed already exists.

---

## Amendment — 2026-09-27 (AER-035): applying a proposal is ONE transaction over a LOCKED row

### The correction this amendment makes, before anything else

The B8c amendment said the applier was "not transactional across its audit row"
and filed that under honest limits. That framing was too small, and the B9a
amendment repeated it without re-examining it. The applier was **not
transactional at all, and not concurrency-safe**, which is a different and worse
fact: it did not merely record a change slightly out of step, it could apply the
same change twice.

The route read the proposal, checked `applied_at`, ran the mutation, wrote the
marker and appended the audit row as **five independent statements with no lock
and no transaction**. Two consequences:

**1. Two concurrent requests could both spend one human's consent.** Both see
`applied_at = NULL`, both pass the consent gate, both mutate.
`rule_to_approval` is the material case: `createApprovalRuleRow` is an
unconditional insert with a fresh id and no proposal reference, so **one
approval could create two live governance rules**, while the proposal row
recorded only whichever `applied_result` committed last.

**2. A crash could leave any two of the three facts disagreeing.** After the
mutation but before the marker: a real change, still replayable. After the
marker but before the audit: an applied change with **no audit row naming who
applied it** — in a product whose entire claim is that every governed change is
attributable, that is the worse of the two.

The existing tests did not catch it because they proved only *sequential* replay
refusal: one request completes before the second begins. That is a different
property, and passing it says nothing about the first.

**Measured, not argued.** With the lock removed, twenty simultaneous applies of
one approved `rule_to_approval` proposal produced **ten successes and ten
approval rules** from a single human approval. With it: one and one.

### Decision

**The whole apply is one transaction, opened with `SELECT … FOR UPDATE` on the
proposal row.**

- **The lock is the serialization point.** A second concurrent apply waits
  there, then sees the `applied_at` its predecessor committed and takes the
  ordinary `proposal_already_applied` refusal. No new error code, no new state
  machine — the existing idempotency gate simply became correct.
- **Every choke point joins the transaction.** `applyRuleEdit`,
  `createApprovalRuleRow`, `applyProjectPatch` and the eight
  `delete*GrantById` functions were widened from `Db` to the ADR-0074
  `DbOrTx` / `DbOrTxDeep` types (plus a new `DbOrTxWrite` for the ones that
  DELETE). This is the structural trick ADR-0074 already established for
  exactly this reason, reused rather than reinvented: `tx.transaction()` opens a
  SAVEPOINT, so `applyRuleEdit → newVersion → activateVersion` nested inside the
  applier's transaction is still ONE database transaction.
- **The success audit is written with the transaction handle.** The local
  `audit()` helper gained an optional writer defaulting to the top-level handle,
  so every other caller is byte-identical and this one commits its row with the
  change it describes.
- **Refusals are audited AFTER the rollback, deliberately.** A refusal throws,
  which rolls the transaction back; a deny row written inside it would roll back
  too, leaving the one case an operator most needs to find unrecorded. So the
  refusal carries the proposal's identity on the error and the deny row is
  appended outside. A test asserts both halves: no applied marker, and the deny
  row present anyway.
- **No idempotency column was added, and that is a decision rather than an
  omission.** AER-035 suggested one for crash recovery. With the mutation, the
  marker and the audit in one commit there is no half-applied state to recover
  from — a crash rolls back all three — so a column would guard a window that
  no longer exists.

### Consequences

- `POST /v1/copilot/proposals/:id/apply` serializes per proposal. The cost is a
  row lock held for the duration of one apply, which is bounded by the choke
  point it calls; the alternative was a governance boundary where a retry could
  duplicate a change.
- New test file `zz-aer035-apply-atomicity.test.ts`: twenty simultaneous applies
  for each of the four kinds, asserting **what the world now holds** (one
  approval rule, one recorded rule edit, the grant gone, the budget written
  once) rather than a tally of HTTP 200s — a route can return one success and
  still have applied twice. For `policy_tightening`, whose write is idempotent,
  the countable artifact is the choke point's own audit row, because the *value*
  cannot distinguish one application from two. The losers are asserted to answer
  `proposal_already_applied` specifically: for `grant_revocation`, a
  `proposal_target_gone` would have meant they ran the removal and found it
  already done — a second execution wearing a different refusal's name.

### Honest limits after this amendment

1. The lock is per proposal. Two DIFFERENT proposals that both edit the same
   rule still interleave; `applyRuleEdit`'s own artifact-row lock (ADR-0074) is
   what orders those, and this amendment does not widen it.
2. No fault-injection test exists for a crash *between* statements inside the
   transaction; the argument that all three facts commit together is the
   database's, not a test's. AER-035's acceptance item 3 is met by construction
   rather than by injected failure, and that distinction is left visible here
   rather than claimed as evidence.
3. `applyRuleEdit`'s SAVEPOINT nesting is exercised by the existing suite
   through the ordinary route, not by a test written for the nested case
   specifically.
4. All limits of the earlier amendments stand unchanged, except the "not
   transactional across its audit row" limit of B8c, which this replaces.

No migration.
