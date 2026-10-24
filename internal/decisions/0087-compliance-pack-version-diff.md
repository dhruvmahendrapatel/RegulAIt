# ADR-0087: Compliance-pack version diff + impact preview — and the regulatory-intelligence feed we refuse to build (gap L15)

- **Status**: Accepted
- **Date**: 2026-08-20
- **Driver**: [GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](../product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md)
  §L15 — regulatory tracking / horizon scanning (Holistic's regulatory tracking, OneTrust's
  regulatory-intelligence feed, watsonx's IBM-maintained accelerators).
- **Migration**: **none.** One new admin route; everything it computes is the shared differ plus
  two calls into the evaluator ADR-0058 already ships. The one durable trace is an ordinary
  append-only `audit_log` row.

## Context

L15 is really two products wearing one label. The first is a **curated feed of legal updates** —
"the EU AI Act's Article 6 guidance changed, here is what it means, here are the workflows to
kick off." The second is an **engineering surface**: when a framework mapping is revised inside
RegulAIt (an ADR-0058 pack v2), nothing showed the admin *what changed and what it would do*
before they activated it. They had two JSON blobs, a partial unique index, and their own
diligence.

ADR-0058 already made a framework revision cheap and safe to *store*: a revision is a NEW
versioned row plus an activation that retires the predecessor, one active version per framework
enforced by the database, every report stamped with the `pack_version` that produced it. What it
never made was the revision **reviewable**.

## Decision

### 1. The feed is refused — permanently, not deferred

RegulAIt will not build or resell a regulatory-intelligence feed. Two reasons, both structural:

- **It is a publisher's product, not a platform feature.** The moat is regulatory-affairs
  staffing — lawyers and analysts reading registers and writing interpretations on a deadline,
  forever. That is ongoing content operations, not engineering, and it is a fight the incumbents
  (and the legal publishers behind them) have already won. The four-vendor analysis said this
  plainly and the Credo-era L3 verdict ("a content/partnership problem more than an engineering
  one") stands.
- **A feed would launder legal advice into the gateway.** ADR-0058's load-bearing honesty is
  that a pack is a control mapping with a disclaimer on every artifact — *not* legal advice, the
  customer's counsel owns the determination. A curated update saying "this regulation now
  requires X, apply this pack" is a legal interpretation with our name on it, delivered through
  the same product that disclaims exactly that authority. No disclaimer survives being attached
  to a push notification that tells customers what the law now means. If a customer wants a
  feed, they buy one from a publisher and the analyst reading it authors a pack revision — as
  data, per ADR-0058's update policy, which needed no new machinery.

### 2. The reviewable revision: diff before activate

**Shared** (`packages/shared/src/compliance-pack-diff.ts`): `diffCompliancePacks(a, b)` — a
deterministic, order-independent structured diff of two pack versions. Controls are matched by
`controlRef`, never position; object-valued fields compare by canonical key-sorted
serialisation so key order is never noise; output lists are sorted and field diffs come out in
one fixed order; the result is zod-typed (`compliancePackDiffSchema`). It reports controls
added / removed / changed (per-field before/after: title, description, coverage, collector,
params, threshold, attestation flag, owner note), pack-level changes, summary counts, and an
explicit `identical: true` when nothing differs. **A `cascadeTag` change is flagged distinctly**
(`cascadeTagChange`, `consequence: "HIGH"`) in addition to appearing among pack-level changes:
the cascade tag is the one pack field with §8.3 enforcement reach — required stages, data-scope
defaults, retention, PII mode all hang off what an Initiative carries — so changing it is a
policy change, not a rename.

**Gateway**: `GET /v1/compliance-packs/:framework/diff?from=<version>&to=<version>` (admin via
the default gate, tagged `compliance-packs`/internal in the openapi registry; 404
`invalid_reference` for a version or framework that does not exist). It returns the structured
diff PLUS an **impact preview**: both versions run through the SAME evaluation machinery —
`evaluatePack`, i.e. `runCollector` over the real ledgers, reused and not reimplemented —
against this deployment's **current** ledgers, and every control whose computed status would
move is reported ("`diff:1.1` satisfied under v1 → unsatisfied under v2 against the same
current ledgers"). Added controls arrive with their freshly computed status; removed controls
show what claim disappears. If the two versions evaluate identically, the response **says so**
(`evaluationIdentical: true`, in words) rather than implying change. The claims/measurement
split is deliberate: the diff half compares the mapping author's *declared* coverage — claims
against claims (ADR-0058: coverage "is the mapping author's claim, not a verified property") —
and the impact preview is the measured half.

**Read-only, with one stated exception.** The endpoint activates nothing, stores no report row,
and moves no pack state — the suite pins all three by delta. It DOES append one audit row
(`compliance-pack-diff-computed`, framework + from/to versions + summary), because the honesty
below needs a ledger, not a memory.

### 3. Activation is informed, never ceremonialised

The packs admin page gains a **"Diff vs active"** view on every non-active version whose
framework has an active one: the structured diff rendered with the cascadeTag flag as an
unmissable banner, then the impact preview table. Activation is **not** gated on viewing it —
requiring a page-load before the button would be ceremony, not control, and a compliance product
faking diligence theatre would be its own indictment. Instead the activation audit row records,
**honestly and nullably**, whether a diff was computed for that from→to pair:
`diffComputed: true` when a `compliance-pack-diff-computed` row exists for exactly that
framework/from/to, `false` when none does (activated blind — visible forever), `null` on a
first activation where there was nothing to diff against. The suite pins all three values.

## Consequences

**Easier.** A framework revision is now a reviewable event: what changed, what it claims, and
what it would do to this deployment's scorecard today, before anything activates — the exact
sliver of L15 that is engineering rather than publishing, and one none of the four vendors
surface because none of them put the mapping and the evidence ledgers in the same system.

**Honest limits, named plainly.**

- **The impact preview reflects THIS deployment's current ledgers at request time.** It is the
  org-wide admin view, for the requested period, computed at the moment of the request. It
  predicts nothing about any future period and is not a compliance forecast.
- **The declared-coverage half of the diff compares claims, not measurements.** The computed-
  status preview is the measured half; the two are kept in separate response sections so one
  cannot be mistaken for the other.
- **Attestations do not carry over.** They are recorded per pack version, so an attested
  organisational control reads `attestation_required` under the new version until a named human
  re-attests. The preview shows that as a move rather than hiding it — it is true, and the
  admin should see it coming.
- **`diffComputed` records that the diff was computed, not that it was read or understood.**
  It is a fact about the audit ledger (anyone computing that from→to diff sets it), not a proof
  of the activating admin's diligence. That is exactly why it never gates.
- **No notification, no scheduler, no watching.** Nothing monitors regulators or pack sources
  for new versions; the diff is pulled by an admin who already has a v2 in hand. That absence
  is §1's refusal holding, not an oversight.
