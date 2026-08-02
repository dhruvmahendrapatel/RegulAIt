# ADR-0057: Continuous Red-Teaming — scheduled adversarial testing that blocks promotion on regression

- **Status**: Proposed
- **Date**: 2026-08-01

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
