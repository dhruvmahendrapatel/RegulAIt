# ADR-0120 — Policy simulation beyond ABAC: a proposed approval rule or rate limit is previewed by the GATE, and a data-scope rule is refused rather than approximated

- **Status**: Accepted
- **Date**: 2026-09-20
- **Relates to**: [ADR-0048](0048-agent-prompt-policy-versioning.md) (a simulation targets an immutable
  version, never "the policy"), [ADR-0073](0073-rules-engine-versioning.md) (rule
  versions, the shadow pass, and the candidate-count recomputation this reuses),
  [ADR-0027](0027-backend-orphans.md) (the `restriction_rule` audit vocabulary)
- **Migration**: **0111** — `policy_simulations.policy_version_id` becomes nullable and gains
  `candidate_artifact_type` / `candidate_version_id`, with a CHECK for exactly one candidate.

## Context

A customer-facing deck lists *"policy simulation and blast-radius preview"* under Assurance. The
surface accepted **one** thing: an ABAC policy version. `runPolicySimulation` looked its argument up
in `abac_policy_versions` and 404'd on anything else, and `policy_simulations.policy_version_id` was
NOT NULL with an FK to that table — so the storage could not describe any other candidate even if the
code had wanted to.

The question a buyer actually asks is *"can I preview what tightening an approval rule does?"*, and
the honest answer was no.

## What was already there, and what was actually missing

ADR-0073's **shadow pass already evaluates candidate approval rules, rate limits and data-scope
rules** on the live path, and already recomputes a candidate limit's count when its window or tool
moves. The evaluation machinery was not missing. What was missing was any way to point the
**preview** surface at it: the shadow evaluates whatever version happens to be marked `canary`, on
real traffic, as it happens — not a named version against a recorded transcript, on demand, before
anyone is affected.

So this ADR adds almost no evaluation logic. It adds a way to *ask*.

## Decision

### 1. `governedEvaluate` gains a dry-run mode that RETURNS the candidate's decision

`simulate: { versionId }` forces one `config_versions` row as the candidate for its artifact type —
regardless of status or canary bucket — and returns what it would have decided as
`candidateDecision`, computed by the same `evaluateWith` the served decision came from. The other two
rule sets stay as served, so a flip is attributable to the rule under test and to nothing else.

**Reusing the gate is the whole point.** A preview computed by a second implementation would drift
from enforcement, and the drift would show up as a confident number that was wrong.

### 2. The dry run SUPPRESSES the canary write, and that suppression is load-bearing

I checked `governed-evaluate.ts` for writes by grepping its own file, found none, and concluded it
was side-effect free. **That was wrong** — it writes through `recordCanaryObservations`, which
inserts into `config_canary_observations` whenever a candidate exists. A replay calling it once per
recorded decision would have written **one canary observation per transcript row**, corrupting the
very measurements an operator relies on, from a function whose module header says it "executes
NOTHING".

It was the M-030 mistake — a universal negative from one narrow check — and it is recorded here
because the fix (`!simulate && notes.length > 0`) looks trivial and its absence would not have been
noticed until someone wondered why their canary percentages had moved.

### 3. `data_scope_rule` is REFUSED, with a reason, and stores nothing

A data-scope rule is evaluated against the call's **arguments**. The MCP decision transcript records
**counts only, never the arguments** (§8.4) — a deliberate privacy property of this product. So a
replayed answer would not be an approximation, it would be a guess with a number attached, on a
surface whose entire value is that its numbers can be trusted.

It returns **422 `artifact_not_simulable`** with a body that explains why, and writes no simulation
row. This is the same shape as ADR-0119's refusals: the product's own discipline is what makes the
feature impossible, and saying so is worth more than a fabricated preview.

### 4. Everything else is shared, deliberately

Same transcript (extracted into `loadReplayTranscript` and used by **both** paths — two previews
reading different evidence would be worse than one preview), same blast-radius vocabulary, same
sampled flips so "which calls, exactly" is answerable, same storage, same scope check.

**No new audit `objectType`.** An approval rule and a rate limit are pillar-1 *restriction rules* and
ADR-0027's vocabulary already covers them, exactly as the ABAC preview audits as `abac_policy` — the
candidate's own kind, never the simulation machinery's.

**The request schema requires exactly one candidate**, refusing both-or-neither in zod rather than
leaving the handler to pick one silently. A preview whose subject is ambiguous is worthless.

## Verification

Two claims matter, and the second is the one a compliance buyer cares about: **it predicts**, and
**it executes nothing**. The execution assertions are deltas around the call — no `approvals` row, no
canary observation, and no row appended to the transcript it was reading — each **paired with a
positive assertion that the run genuinely replayed and genuinely found flips**, because "nothing
happened" is also what a no-op returns (M-033).

**Non-vacuity, predicted before running**: neutralise the candidate evaluation and 2 of 6 redden —
the prediction test and the execution test whose positive control asserts flips — leaving 4 green.
**Result: exactly 2 and 4.**

**Suite: 185 files / 2819 passed / 9 MinIO skips, exit 0** on a freshly created database; repo-wide
build and `tsc --noEmit` clean; instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`).

One defect was caught by `tsc` after the suite was already green: a fixture used `createdByUserId`
where the column is `authorUserId`. Vitest runs through esbuild and never typechecks, drizzle dropped
the unknown key, and the insert "worked" through a full 2819-test run. **A passing suite is not a
typecheck**, and running one after adding a test file is not a substitute for running the other.

## Honest limits

- **Two rule kinds of three.** `data_scope_rule` is refused by design, above.
- **The replay is scoped to MCP tool decisions.** That is the transcript `audit_log` keeps in a
  replayable shape; a proposed rule that would bite on some other governed surface is not previewed
  here.
- **Project attribution is not reconstructed for rule candidates.** The ABAC path rebuilds it from
  the usage ledger because an ABAC policy can read project-derived attributes; approval rules and
  rate limits are scoped by subject, server and tool, so the preview passes `null` and the stored
  flip rows carry no project. A future rule kind that reads the project would need that path too.
- **The preview is only as current as the live rules it runs against.** It substitutes ONE version
  into today's rule set; two proposed changes previewed separately do not tell you what they do
  together.
- **A rate-limit preview inherits the transcript's own gaps.** Counts are recomputed when a
  candidate's window or tool moves, but a window longer than the replay window sees only the calls
  inside it.

## What the deck may now say

> **"Preview a policy change before anyone feels it: name a proposed access policy, approval rule or
> rate limit and see exactly which recorded calls would have gone differently — who, which tools,
> and how many — replayed through the same gate that makes the real decision, executing nothing. A
> data-scope rule is the one kind we will not preview, because judging it needs the call's arguments
> and governed tool decisions deliberately record counts rather than content."**
