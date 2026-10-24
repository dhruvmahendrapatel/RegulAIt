# ADR-0088: The external-scorer adapter — bring your instrument, we bring the governance (gap L14)

- **Status**: Accepted
- **Date**: 2026-08-20
- **Driver**: [GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](../product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md)
  §L14 — purpose-trained low-latency guardrail/scoring models (Fiddler's Centor-class task
  models; Lakera/Check Point beyond that pass).
- **Migration**: 0090 — one new table, `external_scorers`.
- **Extends**: [ADR-0067](0067-groundedness-evaluation.md) /
  [ADR-0072](0072-scoring-semantics-correction.md) (the eval honesty architecture: refuse, never
  degrade; `method` on every stored score), [ADR-0034](0034-custom-llm-providers-egress-guard.md) (egress
  guard + register→test→enable lifecycle), [ADR-0062](0062-mode-scoped-egress.md) (air-gapped
  posture), [ADR-0044](0044-agent-evaluation-harness.md) (the harness the adapter plugs into).
- **Boundary deliberately NOT crossed**: [ADR-0042](0042-guardrail-engine.md)'s inline guardrail
  path stays local-detector only — see §6.

## Context

### The refusal, reaffirmed

The L14 disposition (market analysis §4.8, re-confirmed by the four-vendor pass) stands:
**RegulAIt does not build purpose-trained scoring/guardrail models, and it never fakes one.**
Training scoring models is a different company; and the specific dishonesty ADR-0067 was written
against — a plausible number reported under an instrument's name that never produced it — is
exactly what a half-shipped "scoring model" would be. Nothing in this slice ships a model, and
nothing in it lets a lexical heuristic or any other stand-in wear an external instrument's name.

### What a buyer may legitimately want anyway

An operator who already runs or buys a Fiddler-class scoring endpoint (their own fine-tuned
groundedness scorer, a vendor's hosted one, an internal ML team's shim) has an instrument and
wants its verdicts inside RegulAIt's eval harness — with our thresholds, our baselines, our
drift sweep, our audit trail. The gap analysis named the frame: *"turning their instrument into
our enforcement"* — the operator brings the instrument, the gateway brings the governance.

## Decision

**A registered, governed external scorer for the EVAL path: admin-registered endpoint, the full
ADR-0034 egress lifecycle, the ADR-0067/0072 refusal semantics extended verbatim to a third
method family, and `method: "external:<name>"` stamped on every row it scores.**

### 1. Registration (migration 0090, `external_scorers`)

`name` (unique — the string a scorer config names and the string in the method stamp),
`baseUrl`, `keyCiphertext` (AES-256-GCM under `REGULAIT_DATA_KEY`, write-only, `hasApiKey` on
read — the custom-provider secret discipline verbatim; nullable, because an on-prem shim
authenticating by network position has no secret), `scorerKinds` (the judge-backed kinds the
instrument **claims** to serve), `allowPlaintextHttp`, `enabled` (always false on create),
`lastTestedAt`/`lastTestError`.

The lifecycle is **register → test → enable**, copied from ADR-0034 because it earns its keep
identically here: registration pre-flights the URL through the egress guard (earliest honest
failure), the connection test POSTs a **real probe on our contract** and requires a conforming
reply ("the TCP port is open" is not a connection test), enabling requires a passed test, and
**moving the endpoint re-arms the gate**. Routes: `/v1/external-scorers` (+ `/test`, `/enabled`),
admin-only via the global gate, every act audited under `objectType: "external_scorer"`.

### 2. The contract is OURS, small and disclosed — not Fiddler's API

One POST to the registered `baseUrl`:

```
→ { "input": string, "output": string, "context": string[], "scorerKind": string }
← { "score": number in [0,1], "reasons"?: string[] }
```

- `input` is the **raw case input** and `context` the case's chunk array — never the
  context-framed dispatch prompt, whose flattening would blur the chunk boundaries ADR-0067
  treats as load-bearing.
- The call is bounded (`EXTERNAL_SCORER_TIMEOUT_MS`, 20s) — an eval run must not park on a
  vendor outage.
- The reply parser is deliberately **strict** where the judge parser is tolerant: this is a
  machine contract we published, not a model's prose. No numeric `score`, a non-finite score, a
  score outside [0,1], wrong `reasons` shape, non-2xx, non-JSON — each is a **scorer ERROR,
  never a silent 0 or 1**, and out-of-range is *refused rather than clamped*, because a clamp
  would manufacture a measurement the instrument never made. `reasons` are capped (20 × 500
  chars) — a vendor's output is data, not trusted content.
- We deliberately do **not** chase vendor API dialects (Fiddler's, Lakera's, anyone's). An
  operator whose vendor speaks something else runs a thin translation shim they control. One
  contract keeps the adapter auditable; N vendor adapters would make us the maintainer of other
  companies' API churn.

### 3. Attachment: the eval path, as a third method family

A **judge-backed** scorer config (`llm_as_judge`, `groundedness_judge`,
`answer_relevance_judge`) may name a registered scorer: `scorerConfig: {"externalScorer":
"<name>"}`. Cases so configured are scored by that instrument instead of the model judge.

**The ADR-0067/0072 refusal carries over verbatim.** Pre-flight — after the cases are known,
**before** the `eval_runs` row is inserted — a named scorer that is unknown, disabled, not
claiming the kind, or refused by the egress guard returns a real **422**
(`external_scorer_unknown` / `_disabled` / `_kind_mismatch` / `_unreachable`) with an audited
deny: no run row, no result rows, not one dispatched token, and **never** a fallback to the
lexical estimate or the model judge under the external scorer's name. The decision is a pure
function (`externalScorerAvailabilityFor`, exhaustively unit-tested) mirroring
`judgeAvailabilityFor`. A **mid-run** failure follows the established `judge_failed` idiom: the
row records `error: "external_scorer_failed: …"`, scores 0 with no method stamp, and the run
completes — an errored case is a named error, never a fabricated verdict (ADR-0068's
errored-trial lesson, applied as the eval layer already applies it).

**Method provenance.** Every row the instrument scores carries
`detail.method: "external:<name>"` — a third family beside `lexical-idf-overlap`-style local
methods and `model-judged`, never blended with either. The groundedness summary now groups **per
(metric, method)**: a metric scored by the judge on some cases and an instrument on others
reports two figures under two labels, because averaging a vendor's opinion into a model's
entailment judgement is precisely the blending `method` exists to prevent. Existing runs are
byte-identical (deterministic kinds still summarize as `local-lexical`, judged ones as
`model-judged`).

**The lexical metrics NEVER route externally.** Triply enforced: `externalScorer` on a
deterministic kind is refused at authoring time (422 `unusable_scorer_config`); the registration
schema cannot even claim a deterministic kind; and the runner's deterministic branch never
consults the key. The e2e suite additionally asserts a lexical run leaves the fake endpoint's
hit counter untouched.

### 4. Egress and air-gap posture: inherited, not re-implemented

The scorer URL is an admin-typed destination and therefore an SSRF primitive, so it rides the
**same ADR-0034 guard as a custom provider**: default-deny against the one `egress_allow_hosts`
table (no second allow-list — ADR-0043's rule), per-host private-range and plaintext opt-ins
(two flags, provider half + host half), DNS-pinned guarded fetch that re-validates **per
request**, redirects refused, IMDS unreachable regardless of allow-listing. The guard runs at
registration, at run pre-flight, and inside every scoring call, because DNS can be re-pointed
after approval.

**Air-gapped (ADR-0062)**: a typed destination is strictly adjudicated in *every* deploy mode —
there is no compiled vendor default here for the strict posture to have to close. The suite pins
that the refusal stands with `REGULAIT_DEPLOY_MODE=air_gapped` actually set: a SaaS scoring host
nobody allow-listed is refused before any request, with an audited deny. An air-gapped operator
who runs an **on-prem** scorer allow-lists its host with `allowPrivateRanges` — the same
deliberate, per-host, audited act as an on-prem vLLM (that is the mode's model story, not a hole
in it).

### 5. UI

- **Integrations → External scorers**: registration page on the custom-provider idiom
  (lifecycle stated, refusals verbatim, secret write-only), with the disclosure sentence on the
  page.
- **Evaluations**: the scorer registry response now carries the registered instruments WITH the
  disclosure where the choice is made; run results render a **Method** column on every row; the
  groundedness block reports external figures under their own `external:<name>` label.

### 6. The boundary: the ADR-0042 inline guardrail path is NOT touched

The gap analysis' eventual frame ("bring Fiddler/Lakera verdicts into our block/warn/log modes")
is **deliberately not built in this slice**. An external verdict inside the inline dispatch path
is a network hop on every prompt: a latency decision (the vendor pitch is <100ms; our promise
would be at the mercy of their tail), an availability decision (their outage becomes our
gateway's), and above all a **PII-egress decision** — every user prompt would be POSTed to a
third party from the same layer that exists to control exactly that. The owner has not made
those calls, so the adapter does not make them by stealth.

**Follow-up shape, for when the owner decides.** ADR-0042's detector interface already declares
the slot at the type level — `tier: "heuristic" | "model" | "external"` — but its engine is
deliberately synchronous and pure, so there is **no clean async slot today** that an external
detector could ride without touching the inline path. The honest follow-up is therefore one of:
(a) an **advisory/post-hoc tier** — an out-of-band pass over recorded dispatches that files
log-mode findings through the existing findings pipeline, reusing this ADR's registration,
contract and egress governance unchanged; or (b) a real inline tier, which requires the
latency/availability/PII decisions above to be made explicitly. Neither is built here.

## Honest limits

- **An external score is the vendor's opinion.** The gateway governs the call (egress,
  lifecycle, audit) and records provenance; it does **not** validate the instrument. A
  registered scorer that returns confident nonsense will have its nonsense faithfully recorded
  under its own name — `scorerKinds` is the operator's claim, not our verification, and the ADR
  says so where the UI does.
- **No scorer marketplace, no vendor catalogue, no bundled integrations.** One registration
  surface, one contract. Vendor-specific shims are the operator's.
- **No in-house scoring model** — the L14 refusal is reaffirmed, not softened. Nothing in this
  slice scores anything itself.
- **Renames are not retroactive.** The method stamp is the instrument's name *at scoring time*;
  renaming or deleting a scorer does not rewrite history (deleting one merely makes the next run
  that names it refuse with `external_scorer_unknown`).
- **The external path serves judge-backed kinds only.** An instrument cannot stand in for the
  deterministic metrics, whose whole value is that they are locally computable and free.

## Proof obligations (all in the suite)

Non-vacuity, per M-002 — each mutation was made, shown to redden, and reverted: an adapter that
returns 1.0 without calling out reddens **10** tests (the score gap over identical context, the
wire-shape assertions, every failure-mode test); dropping the method stamp reddens the
provenance test (row + summary); disabling the registration egress validation reddens the
default-deny, IMDS and air-gapped tests. The pure halves (`parseExternalScorerResponse`,
`externalScorerAvailabilityFor`, the authoring-time refusal) are exhaustively unit-tested in
`packages/shared/src/external-scorer.test.ts`; the end-to-end suite
(`apps/gateway/src/external-scorers.test.ts`) runs a real local endpoint through the real guard
with no mocking of the thing under test.
