# ADR-0045: Model Risk Management registry — model cards, a recertification lifecycle, and an optional dispatch gate

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0021 (`org_settings` ceiling model; reversible enforcement toggles),
  ADR-0024 (the `key_custody_enforced` pattern this ADR's dispatch gate copies deliberately),
  ADR-0034 (`custom_model_providers` — model cards must cover self-hosted endpoints too),
  ADR-0044 (agent evaluation harness — the evidence this registry links to)
- **Cross-refs (forward)**: ADR-0044 (eval evidence), ADR-0058 (compliance packs — this registry
  feeds the control mappings), ADR-0046 (review workbench — sign-offs ride the one queue)
- **Standards alignment**: NIST AI RMF (Govern/Map/Measure/Manage), ISO/IEC 42001 (AI management
  system) — explicitly, because regulated buyers ask for it by name.
- **Pillars**: 1 (governance — a new gating rung), 3 (compliance cascade)
- **Migration**: proposed, next free number (0049+). Nothing here ships until this ADR is Accepted.

## Context

RegulAIt's `agents` registry (and, since ADR-0034, `custom_model_providers`) says *how to reach* a
model and *who may invoke it*. It says nothing about whether a model has been **reviewed and
approved for a stated purpose** — the question every AI-governance framework a regulated customer is
audited against (NIST AI RMF, ISO 42001, the EU AI Act's high-risk documentation duties) puts at the
centre. Those frameworks demand, per model: a documented intended use, disclosed data-provenance and
training claims, known limitations, a fairness/bias assessment, a named human sign-off, and a
recertification date after which the approval lapses. RegulAIt today has none of this as structured,
enforceable state.

This is a distinct governance surface from ADR-0044. ADR-0044 answers "is this agent *good* on our
cases?" (a measured score). MRM answers "has a human *accepted the risk* of using this model for
this purpose, on the record, and is that acceptance still valid?" A high eval score is an input to
that decision, never a substitute for it — a model can score well and still be unapproved for a use
that handles regulated data.

The forces:
- A model card that is just a wiki page is worthless at audit time; it must be structured state the
  platform can *enforce* and *expire*, or it is documentation theatre.
- Enforcement that hard-stops production the day an approval lapses is dangerous if it is a surprise;
  ADR-0024 already solved the shape of this problem (a reversible, default-off, org-level toggle with
  an honest "declared vs enforced" label). Copy it, do not reinvent it.
- Provider-agnosticism (CLAUDE.md): a card is per **(agent or custom-provider) × intended use**, not
  per vendor — the same base model used for two purposes may warrant two risk decisions.

## Decision

Add an **MRM registry** — model cards with an approval/recertification lifecycle, optionally gating
dispatch.

### 1. Model cards as structured records

Proposed `model_cards`: id, `agent_id` **xor** `custom_provider_id` (a DB CHECK making exactly one
non-null, the discriminated-union discipline ADR-0034 used), `intended_use` text, `data_claims`
jsonb (provenance, training-data statements, retention claims as the provider states them),
`limitations` text, `bias_fairness` jsonb (see §2), `standard_refs` text[] (e.g.
`nist-ai-rmf:MEASURE-2.11`, `iso-42001:8.3`), `created_by`, `created_at`, `updated_at`. One card is
one risk position on one model-for-a-purpose; a second intended use is a second card.

### 2. Bias/fairness as declared SLOTS, not a testing engine

`bias_fairness` is a **structured placeholder** — a list of `{ dimension, method, result_ref, status,
assessed_at, assessed_by }` entries — where `result_ref` may point at an `eval_run` (ADR-0044) or an
external report. This ADR **does not build a bias-testing engine**; that would be a large, domain-
specific undertaking and pretending a JSON column is one would be dishonest. What it builds is the
*place the assessment lives and is required*, so a card with an empty or stale fairness slot is
visibly incomplete at review time. Stated plainly so no one reads more capability into this than
exists.

### 3. Approval + sign-off + expiry/recertification lifecycle

`model_card_approvals`: id, `card_id`, `status` ∈ `draft|pending|approved|expired|revoked`,
`approver_user_id`, `decided_by`, `decided_at`, `decision_reason`, `valid_until` (the
recertification date), `supersedes_id` nullable. A card moves draft → pending (sign-off requested)
→ approved (with a `valid_until`) → expired (a scheduled sweep flips it when `valid_until` passes) or
revoked (explicit). **The sign-off request rides the one Approvals Queue / review workbench**
(ADR-0046), not a bespoke inbox — one approval surface in the product (GOVERNANCE_LAYER_SPEC §6).
The expiry sweep follows the ADR-0032/0035 scheduler posture (loud, admin-visible, ledgered).
New `audit_log.object_type` value `model_card` (plain-text column, no DDL). Recertification is a new
approval superseding the prior one, so the history of who accepted what risk, when, and until when
is a durable chain — never an edited-in-place field.

### 4. Optional dispatch gate — default OFF, reversible, honestly labelled

`org_settings.mrm_enforced` (default **false** = today's behaviour, byte-identical). When **true**,
`executeGovernedDispatch` gains a rung — after entitlement, before the provider call — that refuses
to dispatch an agent whose model has **no card with an unexpired `approved` approval**, returning a
**409 `mrm_approval_required`**, audited (`ruleId: mrm-approval-required`, `effect: deny`). This is
deliberately the exact shape of ADR-0024's `key_custody_enforced`: one org toggle, refuse-with-a-
named-reason, fully reversible (turning it off restores dispatch; no card data is destroyed), and a
**computed honest posture label** so the UI shows "ENFORCED by this deployment" vs "DECLARED but not
enforced" rather than ever claiming an assurance the toggle does not back. Compliance beats
convenience: where a compliance classification (GOVERNANCE_LAYER_SPEC §8.3) requires MRM, the cascade
sets this toggle and it cannot be relaxed below what the classification demands (ADR-0021 ceiling).

### 5. Links to eval evidence (ADR-0044) and feeds the compliance packs (ADR-0058)

- A card references `eval_run` ids as its measured evidence; the reviewer sees the score history
  behind the model without leaving the card.
- The MRM registry is a **control-evidence source** the compliance packs (ADR-0058) map onto:
  "model inventory with documented intended use and approved risk acceptance" is a named control in
  NIST AI RMF and ISO 42001, and the card fields carry the `standard_refs` that let a pack render
  that mapping. ADR-0058 owns the control catalogue; this ADR owns the model-side evidence it points
  at.

## Consequences

### Easier
- A regulated buyer's "show me your model inventory, its intended uses, its risk sign-offs, and when
  they expire" is answered from structured state, not a scramble of docs — the differentiator that
  turns "we're governed" into an audit artifact.
- The dispatch gate makes "no unreviewed model reaches production data" an **enforced** property, not
  a policy on a slide — using a proven, reversible mechanism rather than a novel risky one.
- Recertification prevents approvals from silently outliving the conditions they were granted under.

### Harder / given up
- **The gate can hard-stop production the day a certification lapses.** That is the point, but it is
  operationally sharp: the expiry sweep must warn well before `valid_until`, and lapses surface in
  the review workbench (ADR-0046) as work, not as a 3 a.m. outage. Default-off means no deployment
  gets this behaviour by accident.
- **Bias/fairness is a slot, not an engine** (§2) — the platform *requires and records* an
  assessment; it does not *perform* one. Overstating this would be the worst possible failure mode
  for a governance product, so it is stated flatly.
- **Cards are human work.** An empty registry enforces nothing; the value appears only once cards are
  authored and signed off. The platform can require them (via the cascade) but cannot write them.
- **Standards alignment is a mapping, not a certification.** Referencing NIST AI RMF / ISO 42001
  control ids helps an auditor; it does not make RegulAIt or its customer *certified*. ADR-0058
  carries that framing for the whole compliance-pack surface.

### Follow-up
- ADR-0058 defines the compliance-pack control catalogue this registry's `standard_refs` resolve
  against.
- Decide whether `mrm_enforced` should be expressible per-project via the compliance cascade in
  addition to org-wide (likely yes — a HIPAA project may enforce while a sandbox does not).
