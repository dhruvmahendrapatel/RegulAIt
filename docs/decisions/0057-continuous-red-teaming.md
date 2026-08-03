# ADR-0057: Continuous Red-Teaming — scheduled adversarial testing that blocks promotion on regression

- **Status**: Accepted
- **Date**: 2026-08-01
- **Amended**: 2026-08-02 — implemented as **migration 0070**. See the amendment at the foot of
  this file for what is genuinely enforced, what is structural, and the honest limits.

## Context

Runtime guardrails (ADR-0042) are *reactive*: they inspect a live request/response and block or
redact at the moment of use. They are necessary and they are not enough. A guardrail only catches
what it is configured to catch, on the traffic that actually arrives; it cannot tell you *in
advance* that the agent you are about to promote will leak PII when asked a certain way, or that a
model upgrade quietly regressed its jailbreak resistance. The industry lesson — and the regulatory
one now baked into the EU AI Act and NIST AI RMF (see ADR-0058) — is that adversarial testing has
to be **proactive, continuous, and gating**, not a one-time pre-launch pentest whose result is
stale the day a prompt or a model version changes.

RegulAIt is uniquely positioned to do this because it already sits at the choke point. Every agent
the platform governs is reachable through `executeGovernedDispatch` and the provider-agnostic model
catalog (ADR-0034); every governed run already writes to `audit_log` and `usage_events`; and the
workflow engine (pillar 2) already has an `automated_check` stage that **parks an instance at
`blocked_on_check` and refuses to advance when a required check fails**. That last primitive is the
whole mechanism we need: red-team results can be a required check on the promotion workflow, so a
security regression physically cannot be promoted, in exactly the same way a failed CI check
cannot today.

The forces:

- **Proactive vs. reactive must compose, not compete.** Red-teaming complements guardrails; it does
  not replace them. Guardrails stop the live attack; red-teaming discovers the class of attack
  before it reaches production and measures whether the guardrails actually hold.
- **Provider-agnosticism.** The agents we govern run on any model (Claude, GPT, Gemini, Grok,
  open-weight, admin-registered custom endpoints). The attack library and the harness must be
  model-neutral — an attack is expressed against the governed *agent surface*, not against one
  vendor's API.
- **Gating requires a stable baseline.** "Block on regression" only means something if there is a
  recorded prior result to regress *from*. That is what the MRM registry (ADR-0045) is for — it
  holds each model/agent version's evaluation record, and red-team scores become part of that
  record, versioned alongside it.
- **Honesty about limits.** Red-teaming reduces risk; it never proves safety. A green suite means
  "none of our current attacks succeeded," never "no attack can succeed." Claiming otherwise would
  be the exact overclaim this project has refused everywhere else (ADR-0034, ADR-0035).

## Decision

Build **Continuous Red-Teaming** as a scheduled adversarial-testing subsystem that probes the
agents the platform *governs*, records results in the MRM registry (ADR-0045), and **blocks
promotion on regression** via the workflow engine's existing `automated_check` gate.

**1. A versioned, provider-agnostic attack library.** Attacks are data, not code — a versioned
library of probe definitions across the core threat classes: **prompt injection** (direct and
indirect/via-tool-output), **jailbreak** (safety-bypass, role-play escapes), **data exfiltration**
(coaxing an agent to leak system prompts, other users' context, credentials, or cross-tenant audit
rows — directly relevant to the governance copilot, ADR-0056), **PII leak** (does the agent emit
PII it was given or can reach, in violation of its compliance-cascade PII mode?), and **bias**
(disparate or discriminatory outputs on matched prompts). Each probe declares its target class, its
success/failure oracle, and a severity. The library is versioned so a run records *which* library
version it was scored against, and so adding attacks is a data update, not a redeploy — the same
posture the model-endpoint catalog (ADR-0034) and the shadow-AI signature catalog (ADR-0055) take.

**2. Probes run through the same governed surface as real traffic.** The harness invokes the target
agent via `executeGovernedDispatch` / the compat surfaces — *not* a side channel — so a probe
exercises the real routing, the real system prompt (`agents.systemPrompt`, ADR-0023), and the real
runtime guardrails (ADR-0042) exactly as production would. This is what lets red-teaming *measure*
whether the guardrails hold, rather than testing the model in a vacuum where the guardrails are
absent. Probe runs are metered and audited like any other governed call (with a distinguishing
origin tag so red-team traffic is never mistaken for real usage in the cost dashboard).

**3. Scheduled + event-triggered.** Runs fire on a schedule (nightly/weekly per policy) and on
change events — a new model version, a changed system prompt, a new agent registration, an updated
attack-library version. The scheduling reuses the platform's existing scheduler infrastructure
rather than inventing a new one, and a failed scheduler surfaces loudly (the ADR-0031 discipline:
log + admin-visible health + a deny-effect audit row, never silent).

**4. Results land in the MRM registry, versioned per model/agent.** Each run writes a scored result
per attack class into the MRM registry (ADR-0045) against the specific model/agent *version* under
test — establishing the baseline that "regression" is measured against. A result carries the attack
library version, per-class pass/fail counts, severities, and links back to the offending
transcripts in `audit_log`/`usage_events` for investigation.

**5. Promotion-blocking gate on regression.** The promotion workflow for any governed agent gains a
required `automated_check` stage — "red-team regression" — that resolves against the MRM registry:
it **fails (parks the instance at `blocked_on_check`) if the candidate version scores worse than
the established baseline on any gating attack class, or worse than an absolute floor.** Because the
workflow engine already refuses to advance a failed required check, no code path is needed to
"enforce" the block — it is the same gate that stops a failed CI check today. A human can override
only through the workflow's existing, audited override path (never silently), and an override on a
security regression is itself a loud, logged decision the copilot (ADR-0056) can later flag.

**6. Compliance-cascade aware.** Which attack classes are *gating* (block promotion) vs.
*reporting-only* is driven by the compliance classification (pillar-3 §8.3) of the Initiative the
agent serves — a HIPAA workload gates PII-leak strictly; a public-facing workload may gate
jailbreak and bias more strictly. The compliance packs (ADR-0058) ship these gating presets so a
customer does not hand-configure them per framework.

**7. A regression is a comparison, and the baseline can move deliberately.** "Worse than baseline"
is evaluated per gating class against the last *promoted* version's stored score in the MRM
registry, plus an absolute floor per class so a chronically weak baseline cannot bless a still-weak
candidate. When a candidate legitimately improves, its scores become the new baseline on promotion —
so the gate ratchets forward and cannot silently erode. Re-scoring an already-promoted version under
a *newer attack-library version* can surface a regression that was invisible when it shipped
(a newly-authored attack it never faced); that does not retroactively un-promote it, but it does
raise a finding the copilot (ADR-0056) flags and can open a remediation workflow — the honest
consequence of a library that keeps growing.

## Consequences

**Easier.** Security posture becomes *measured and enforced* rather than asserted. A model upgrade
can no longer silently regress jailbreak resistance into production, because promotion is gated on
the MRM baseline. Because probes run through the real governed surface, we get a true measurement of
the guardrail-plus-model system as deployed, not a lab artifact. Because the gate reuses the
`automated_check` primitive, the enforcement is the workflow engine we already trust, not a new
bespoke blocker. And red-team results become sellable evidence — an EU AI Act / NIST AI RMF
requirement satisfied with an auditable trail (ADR-0058).

**Harder / explicitly given up.**

- **Green never means safe.** This is the central honest limitation: a passing suite means "no probe
  in library version *v* succeeded against this version," full stop. Novel attacks, attacks we have
  not authored, and attacks that only manifest against real user data are out of scope by
  construction. We report *coverage* (which classes, how many probes, library version) alongside
  results, and we never render a "secure" verdict — only "no known regression."
- **The attack library is a maintenance commitment and will lag.** Adversarial techniques evolve
  faster than any static library. Making attacks versioned data (not code) minimizes update cost,
  but a brand-new technique is invisible until authored. The library version stamped on every
  result makes that lag legible instead of hidden.
- **Adversarial testing has cost and side effects.** Probes consume tokens/budget and generate
  traffic that must be tagged so it never pollutes cost attribution or anomaly detection (pillar 5).
  A poorly-scoped exfil probe could, in principle, cause a real tool call — so probes run against
  agents in a non-production posture or with mutating tools disabled, and this scoping is a
  first-class part of the harness, not an afterthought.
- **Non-determinism makes "regression" fuzzy.** LLM outputs vary run to run, so a single failing
  probe may be noise. The gate must score over repeated trials with a threshold, not a single shot,
  or it will flap — accepted as a design requirement, with the trade-off that a rare-but-real
  failure can slip a probabilistic gate. Severity-weighting and repeated trials mitigate; they do
  not eliminate.

**Follow-up work.** The attack-library format and versioning (shared design language with the
ADR-0034 and ADR-0055 catalogs). The harness that drives probes through `executeGovernedDispatch`
with an origin tag and non-production scoping. The MRM-registry (ADR-0045) result schema and the
baseline-comparison logic. The "red-team regression" `automated_check` stage type and its resolver
against the registry. Per-framework gating presets shipped by the compliance packs (ADR-0058). And
a clear in-product statement of the coverage-not-proof limitation on every red-team report.

---

## Amendment — 2026-08-02: implemented as migration 0070

**Status: Accepted.** Shipped as `packages/shared/src/redteam.ts` (pure),
`apps/gateway/src/redteam.ts` (gateway), migration
`packages/db/migrations/0070_continuous_red_teaming.sql`, the admin screen
`apps/web/src/views/admin/governance/RedTeamPage.tsx`, and the proof-by-attack suite
`apps/gateway/src/redteam.test.ts` (20 tests).

### The one decision that shaped everything: there is no second harness

A red-team suite **is** an ADR-0044 eval suite whose cases are adversarial probes and whose scorer
asks the inverted question. So:

- a probe is materialized into an ordinary `eval_cases` row;
- a run is `runEvalSuite` → `executeGovernedDispatch`, the same governed core an invoke takes;
- the transcript, the entitlement check, the guardrail pass, the `usage_events` cost row and the
  `audit_log` row are the ones that already existed;
- **promotion blocking needed no new code at all** — a published attack library *is* an eval
  dataset, so an `automated_check` stage binds to it with ADR-0044's existing `evals:` binding, and
  a regression parks the instance at `blocked_on_check` through the existing `check_failed` route.

Migration 0070 adds only the four things an eval run cannot express: which **attack library
version** scored it (`redteam_libraries`, `redteam_probes`), the **security reading** of one eval
run (`redteam_runs`), and **which probes got through** (`redteam_findings`). Red-team results reach
a model card through the **existing** `model_card_evidence` table (`kind = 'eval_run'`, ADR-0045
§5) — there is no parallel evidence surface and no parallel approvals surface.

### Genuinely enforced (asserted by test, not by comment)

- **The corpus produces true positives AND true negatives.** The shipped `regulait-core` v1 corpus
  (nine probes across all five attack classes) run against a *clean* agent resists eight probes and
  is defeated by one — the deliberate **positive control** (`pii-positive-control`), which drives
  the deterministic rig down its known leak path so the corpus is provably able to report a defeat.
  Re-run against the *same agent* with a canary in its system prompt, the exfiltration and
  injection oracles that were silent now fire. A scorer that flagged everything, or nothing, would
  fail both halves.
- **An oracle that cannot flag is refused at authoring time** (HTTP 422): a `contains` with no
  `forbidden` markers, a non-negated `regex`, and any reference-answer scorer. Same anti-theatre
  gate ADR-0044 applies to eval scorers, from the adversarial direction.
- **Red-team dispatch is governed.** A user with no grant on the agent gets the ordinary
  `agent_not_entitled` denial with the decision shape and a deny row in the one audit log — and the
  test asserts that no eval run and no `usage_events` row was created, so nothing was dispatched.
- **Adversarial traffic is metered and tagged.** One `usage_events` row per probe, attributed to
  the run's project, each carrying `detail.purpose = 'redteam'` — so probe spend is billed and is
  separable from real usage in the pillar-5 dashboard rather than polluting it.
- **A defeat reaches model-card evidence.** The finding row points at the `eval_results` row that
  proves it (asserted against the real transcript, not the finding's own copy), and attaching it to
  a card is read back **through the MRM route** with the same `mrm-evidence-attached` audit ruleId.
- **A regression blocks promotion through the existing check.** Asserted as the workflow *state*
  (`blocked_on_check`) plus the `workflow:check_failed` audit row, and asserted to unblock again
  once the regression is undone — a gate, not a wall.
- **A library version freezes on publish**; editing mints the next version, copying its probes.

### Structural, not behavioural

- The **per-class gating vs. reporting split** (§6) is implemented and unit-tested
  (`evaluateRedTeamGate`), but nothing yet *derives* the gating classes from an Initiative's
  compliance classification — the caller passes them. Wiring the compliance cascade to supply
  per-framework gating presets is ADR-0058's shipped-packs work, not this one's.
- **Non-production scoping of probes** (§"adversarial testing has side effects") is inherited
  rather than added: probes are ordinary governed dispatches, so the §8.3 `read_only` compliance
  mode and the ADR-0042 guardrails already constrain what a probe can cause. There is no separate
  "red-team sandbox" posture, and a deployment that grants an agent mutating tools will have probes
  that can reach them.
- **Repeated trials** are not implemented. §"non-determinism makes regression fuzzy" is correct and
  unaddressed: each probe runs once. With a deterministic provider this is exact; against a real
  model it would flap, and the gate would need N trials with a threshold before it could be trusted
  to block.

### Honest limits

- **No model provider is connected in this environment.** Every probe here was answered by the
  in-memory deterministic provider. What is proven is the **mechanism** — corpus, oracle,
  aggregation, per-class gate, findings, evidence, workflow block. What is *not* proven is any real
  model's actual resistance to any real attack. Model-graded probes ride ADR-0044's `EvalJudge`
  interface unchanged: mechanism-proven, judgment-unverified.
- **The oracles are marker-based, and markers under-report.** A model that complies in substance
  while avoiding the marker phrasing scores as "resisted". The leak oracles need a canary token in
  the agent's configuration to have anything distinctive to detect; without one, a clean result
  means "nothing recognisable leaked", which the API and the screen both say.
- **Green never means safe**, and the product says so rather than only the ADR: every red-team
  response carries `RED_TEAM_COVERAGE_DISCLOSURE`, every attack class renders what it *cannot* tell
  you next to what it does, and the gate's own pass reason is worded "no known regression … never
  'secure'".
- **There is still no in-process scheduler** anywhere in this codebase — the same disclosure
  ADR-0044 through ADR-0049 made. "Continuous" means an operator or cron drives
  `POST /v1/redteam/runs` with `trigger: 'scheduled'`, and the run records which trigger fired it.
  A missed schedule is silent; the run history is the only health signal, and that gap is stated in
  the `GET /v1/redteam/attack-classes` payload rather than hidden.
