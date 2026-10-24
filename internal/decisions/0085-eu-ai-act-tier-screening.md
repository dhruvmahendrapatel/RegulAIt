# ADR-0085: EU AI Act risk-tier screening on the use-case intake — a calculator, not a lawyer

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: `0089_use_case_eu_tier.sql` — three nullable columns on `ai_use_cases`
  (`eu_ai_act_tier`, `eu_ai_act_reasons`, `eu_ai_act_ruleset_version`), NO new table.
- **Driver**: [GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](../product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md)
  gap **L10** — Holistic AI's EU-AI-Act risk calculator / OneTrust's conformity assessments,
  named there *"build next — highest leverage-to-effort of this pass"*, deadline-adjacent
  (high-risk obligations apply from August 2026), and the one move nobody else can make:
  *"their classifier ends in a report, ours ends in enforcement"* — or, honestly, ends in the
  **existing** cascade.
- **Extends**: [ADR-0080](0080-ai-use-case-registry.md) (the intake and questionnaire this
  rides), [ADR-0058](0058-compliance-packs.md) (the eu-ai-act pack whose cascade tag and control
  vocabulary the tier speaks), [ADR-0083](0083-shadow-ai-first-party-discovery.md) and
  [ADR-0068](0068-redteam-depth.md) (the frozen, hash-pinned compiled-corpus discipline the
  rule set copies).

## Context

The eu-ai-act compliance pack (ADR-0058) maps *high-risk obligations* to controls and the §8.3
cascade enforces posture for a tagged project — but nothing classified a use case into the Act's
own tiers (prohibited / high / limited / minimal). The ADR-0080 intake asks about compliance
tags without telling the proposer *which* tags the Act's own logic points at. Vendors sell this
as a standalone calculator ending in a PDF; ours can end in the tag vocabulary the enforcement
plane already reads.

## Decision

### 1. A frozen, deterministic rule set — provenance stated, versioned forever

`EU_AI_ACT_RULESET_V1` (`packages/shared/src/eu-ai-act.ts`): **17 rules**, authored 2026-08-20
from the **published text of Regulation (EU) 2024/1689** — Art. 5 prohibitions (4 rules:
social scoring, manipulative/exploitative techniques, emotion recognition in workplace/
education, real-time-style remote biometric ID for law enforcement reaching the public),
Art. 6 + Annex III high-risk (11 rules: safety component, remote biometric ID, emotion
recognition, the seven Annex III domains gated on an Art. 6(3) materiality screen, and the
Art. 6(3) profiling override that removes that screen), Art. 50 transparency (2 rules: direct
interaction, synthetic content). Every rule is **plain data** (field/op/value conditions — no
functions, no regex), deep-frozen, and the shared suite pins **rule count and a sha256 content
hash**, so v1 can never drift silently. A revision is a **v2 alongside v1, never an in-place
edit** — stored results keep the version that produced them.

`classifyEuAiActTier(answers)` fires every matching rule, reports each with its
Annex/Article-shaped plain-language reason, and takes the highest tier
(**prohibited > high > limited > minimal**; minimal = *no rule fired*, empty reasons, never a
fabricated one). The suite proves every tier reachable and **every rule load-bearing**: for
each rule, a fixture fires it and removing its trigger answer strictly drops the tier —
including the 1:1-verification exclusion (dropping remote-ID to `verification` goes to
minimal) and the Art. 6(3) pair (an Annex III domain at `narrow-procedural` autonomy is out of
high **until** `profilesNaturalPersons` puts it back).

### 2. Computed server-side, from the answers, on submit — a tier is never an input

The ADR-0080 questionnaire gains a structured section: a single fenced
` ```eu-ai-act-answers ` JSON block inside the same versioned markdown artifact the sign-off
decides on — so the record decided on and the record the tier came from are **the same
document at the same version**. On every questionnaire submission (and on the decide-path
sync, harmlessly idempotent), the gateway extracts the block, classifies, and stores
tier + firing reasons + rule-set version on the use case, with an audit row per change.
Re-submission (the kernel's versioned re-approval) recomputes. No valid block → all three
columns **null** ("not screened" — the platform never guesses a tier from prose).

A submitted tier is refused at every door: the answers schema is strict and a smuggled `tier`
key invalidates the whole block with a "computed server-side" refusal; a PATCH naming
`euAiActTier` (or the sibling columns) 422s **by name** (`eu_tier_is_computed_not_patched`),
exactly the ADR-0080 `status` discipline. Non-vacuity was proven the M-002 way, both halves:
no-op the server-side computation → 5 of the 8 endpoint tests redden; make the rule set
always-minimal → 19 of 32 shared tests and 4 of 8 endpoint tests redden. Both probes reverted
by reversing the exact edit.

### 3. The cascade ending — and the honest decision NOT to auto-block

**Decision: the tier INFORMS the human sign-off; nothing auto-blocks on it.** ADR-0080 already
states approval gates no dispatch — a tier that silently blocked would bolt *more* enforcement
onto a screening result than the platform applies to the approval itself, and would overclaim
a legal judgement this calculator explicitly is not. So: a `prohibited` tier renders an
unmissable refusal-shaped banner **for the human who decides**, the pending sign-off still
exists, and the decide path is byte-identical — the suite proves a prohibited use case can be
denied *and* approved by its human, with the tier surviving as the recorded "why".

Where the tier does end: a `high`/`prohibited` tier's detail view derives — **live, the
ADR-0080 way, never a stored copy** — the active `eu-ai-act` compliance packs, the §8.3
cascade tag each drives, whether a compliance profile for that tag actually exists in this org
right now, and the pack's control references cited **read-only** (the ADR-0058 vocabulary).
The test writes the profile mid-test and watches `profileExists` flip on the next read.
Carrying the recommended tag (and classifying the governed project with it) is what turns the
screening into enforced cascade consequences — through machinery that already exists.

### 4. Surfaces

- Shared: classifier + rule set + parser + `EU_AI_ACT_SCREENING_DISCLAIMER` (a **field** on
  every result and every read, never a strippable footer): screening, derived from the public
  Act text, **not legal advice**, self-reported answers, subset of the Act's nuance.
- Gateway: no new routes — the screening rides `GET /v1/use-cases/:id` (`euAiActScreening`),
  the columns ride the existing list/detail rows, and the computation rides the existing
  lifecycle sync. Audit ruleId `use-case-eu-tier`.
- Web: the UseCasesPage questionnaire renders the structured controls and serializes the
  answers block; the detail shows the tier badge, firing reasons, disclaimer, the cascade
  recommendation, and the prohibited banner. Playwright drives the prohibited path end to end
  (`zz-use-case-eu-tier.spec.ts`).

## Honest limits

- **Self-reported.** The answers describe what the proposer says the system does; screening a
  lie produces a confident wrong tier. The signed-off questionnaire is at least the versioned
  record of what was claimed.
- **A subset of the Act.** GPAI-model obligations, the Art. 5/6 exception lattices,
  notified-body conformity routes and member-state specifics are not encoded. The rule set
  says which article shaped each reason so a counsel can check the mapping.
- **The rule set will date.** Guidance and delegated acts will move; the answer is
  `EU_AI_ACT_RULESET_V2` next to v1 — never an edit under stored v1 results. `rulesetVersion`
  on every row is what keeps old screenings honest.
- **No auto-block, restated.** A prohibited tier blocks neither the sign-off nor (per
  ADR-0080) any dispatch. If approval ever gates dispatch, tier-aware gating belongs in that
  ADR, not silently here.
- **The recommendation is only as real as the org's packs/profiles.** With no active
  eu-ai-act pack or no profile for its cascade tag, the cascade ending honestly reports what
  is missing instead of inventing a tag.
