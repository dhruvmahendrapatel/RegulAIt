# ADR-0042 — A layered input+output guardrail engine extending PII enforcement

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0007/0008 (pillar 1 governance, pillar 3 compliance cascade), ADR-0023
  (schema depth — `mcpMode`, one dispatch core), ADR-0024 (interception depth — every gateway
  call metered/governed at one point), ADR-0031 (P0 hardening), ADR-0034 (egress guard —
  governs the *destination*, explicitly NOT the *content*), GOVERNANCE_LAYER_SPEC §3
  (approval/rate/data-scope rules), §8.3 (compliance cascade's PII handling mode)
- **Cross-refs (planned, not yet written)**: ADR-0057 (continuous red-teaming — the process this
  engine pairs with)
- **Migration**: none in this ADR — schema (per-project/per-agent guardrail config, classifier
  registry) is named as follow-up. This records the decision and the shape.

## Context

The gateway already enforces exactly one content-safety control: **PII detection**. In
`apps/gateway/src/projects.ts`, `enforcePII(mode, {input}|{output})` runs a regex-based PII scan
with a three-verb posture — `PiiMode = "block" | "warn" | "log"` — and it is wired into
`executeGovernedDispatch` (`agents-connectors.ts`) at both the **input** phase (before the model
call, a `block` refuses with an audited deny) and the **output** phase (after, `block` withholds,
`warn` annotates, `log` records). The same enforcement runs on the connector path and the MCP path,
and the effective `piiMode` is driven by the compliance cascade (`projectPiiMode` → the strictest
`piiMode` across a project's compliance profiles, falling back to `org_settings` default).

This is the right *shape* — inline, inside the one governed dispatch core, inheriting audit,
entitlement, cost attribution — but it is a **single regex classifier for a single harm class**.
It does nothing about prompt injection, jailbreak attempts, toxic/abusive content, or data
exfiltration that is not a regex-matchable PII pattern (e.g. a customer's confidential roadmap
pasted into a prompt bound for an external model endpoint). A governance product that intercepts
every AI call (pillar 1) and sells to regulated buyers (ADR-0041) cannot have exactly one
content control at that chokepoint.

This is owner backlog item **D6** (guardrails) merged with the guardrail-**depth** item **F2**.

## Decision

**Generalize the existing PII enforcement into a layered, pluggable guardrail ENGINE that runs at
the same interception point (`executeGovernedDispatch`), keeps the `block | warn | log` verbs, adds
input- and output-side classifier layers beyond regex PII, and is per-project / per-agent tunable
under the compliance-cascade ceiling.** PII enforcement becomes the first classifier registered in
the engine, not a special case beside it.

### 1. Keep the verbs, keep the placement

The engine's decision vocabulary stays **`block | warn | log`** — the same `PiiMode`-style triad,
now generalized to a `GuardrailAction`. It runs **inside `executeGovernedDispatch`**, at the two
phases PII already uses:
- **input phase** — after entitlement/routing/budget, before the provider call. A `block` from any
  layer is an audited deny with nothing leaving the box (identical to today's PII input block, and
  it composes with ADR-0034's egress guard: content control and destination control are
  independent gates).
- **output phase** — after the response, before it is returned/streamed. `block` withholds, `warn`
  annotates, `log` records — exactly the existing PII output semantics.

Because it lives in the one core, every guardrail evaluation **inherits audit, per-user
entitlement, and cost attribution for free** — the same argument ADR-0034 and ADR-0024 make. There
is no second interception point and no bypass.

### 2. The added layers

Each is a **classifier** producing per-category hit counts (never the matched substrings — the same
counts-only contract PII already holds, so guardrail audit rows never themselves become a leak):

- **Prompt-injection detection** (input) — instruction-override / tool-hijack patterns in
  user-supplied or tool-returned content. Tool output is in scope precisely because ADR-0034's
  amendment showed a governed pipe can carry attacker-chosen bytes back.
- **Jailbreak detection** (input) — known jailbreak framings and policy-evasion structures.
- **Toxicity / content moderation** (input + output) — abusive/harmful content in either
  direction.
- **Semantic DLP beyond regex** (input + output) — the exfiltration class PII regex misses:
  classifier-scored sensitivity rather than pattern match, so "our unreleased roadmap" is catchable
  even without a formatted identifier.

### 3. Pluggable classifiers, conservative default posture

- **Classifier tiers**: **heuristic** (local, deterministic, zero-cost, no network — the tier PII
  already is), **model-based** (a small local or configured classifier model), and **optional
  external** (a third-party moderation API). External classifiers are **default-off** and, when
  enabled, **route through the ADR-0034 egress guard like any other outbound destination** — a
  guardrail must never be a covert exfiltration channel, so its own calls are governed too.
  Air-gapped deployments (ADR-0041) get the heuristic and local-model tiers with no external
  dependency, by construction.
- **Default posture is conservative**: the shipped default is heuristic-only, PII at the cascade
  ceiling, other layers `log` (observe-then-tune) rather than `block`, so enabling the engine does
  not silently start refusing traffic. An admin dials each layer up to `warn`/`block` deliberately.
- **Per-project / per-agent tunable, under the cascade ceiling**: like `piiMode` today, each
  layer's action is configurable per project and per agent, but the **compliance cascade (§8.3) is
  the ceiling** — a project's classification can *raise* the floor (force a layer to `block`) and a
  local setting can never relax below it. This is the same "cascade is the authoritative ceiling"
  rule TOKEN_OPTIMIZATION_SPEC's dials already obey.

### 4. Provider-agnostic

The engine sits above the provider adapters, so it is identical across Anthropic / OpenAI / Google
/ xAI and every ADR-0034 custom endpoint. A self-hosted model gets the same guardrails as a SaaS
one — which is the point for the regulated single-tenant buyer.

## Consequences

### Easier

- The chokepoint gains real defense-in-depth instead of one regex. Injection, jailbreak, toxicity,
  and semantic DLP become first-class, audited, cost-attributed governance decisions.
- PII stops being a special case: it is classifier #1 in a registry, so adding the next harm class
  is a registration, not a new code path threaded through three dispatch surfaces.
- The compliance cascade gets teeth beyond `piiMode`: a HIPAA/PCI classification can force
  injection and DLP layers to `block` automatically, cascaded exactly as PII already is.

### Harder / given up — stated honestly

- **False positives and latency are real trade-offs.** Every added input-phase classifier is
  latency on the request path, and model-based classifiers add both cost and misclassification.
  This is why the default posture is heuristic-only and `log`-not-`block` — the engine is built to
  be tuned into strictness, not to arrive strict and break traffic. The counts-only audit contract
  is what makes tuning possible without the audit log itself leaking.
- **No guardrail is complete.** This is defense-in-depth, not a proof of safety. Any classifier can
  be evaded; a `block` posture reduces risk, it does not eliminate it. This ADR is explicit that
  the engine **pairs with continuous red-teaming** (planned ADR-0057) — the guardrails are the
  standing control, red-teaming is the process that finds what they miss and feeds the next
  classifier. Neither substitutes for the other.
- **Semantic DLP and injection detection are the least mature layers** and should ship in `log`
  mode first, precisely so their false-positive profile is measured on real traffic before anyone
  is invited to set them to `block`.
- **This ADR decides the shape; it does not build the classifiers or the config schema.** The
  per-project/per-agent guardrail configuration and the classifier registry are named follow-up
  slices. What is decided now is: extend, don't replace; keep the verbs and the placement; default
  conservative; cascade is the ceiling; external classifiers are governed like any egress.

### What this explicitly does NOT do

- It does not inspect or govern the *destination* of a call — that is ADR-0034's egress guard, a
  separate and independent gate. Content-in and destination-out are orthogonal controls that happen
  to sit in the same core.
- It does not claim to catch every unsafe input or output. A guardrail that claimed completeness
  would be the dangerous kind. This one is honest about being one layer of several.
