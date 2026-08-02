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
