# ADR-0045: Model Risk Management registry — model cards, a recertification lifecycle, and an optional dispatch gate

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0057)
- **Relates to**: ADR-0021 (`org_settings` ceiling model; reversible enforcement toggles),
  ADR-0024 (the `key_custody_enforced` pattern this ADR's dispatch gate copies deliberately),
  ADR-0034 (`custom_model_providers` — model cards must cover self-hosted endpoints too),
  ADR-0044 (agent evaluation harness — the evidence this registry links to)
- **Cross-refs (forward)**: ADR-0044 (eval evidence), ADR-0058 (compliance packs — this registry
  feeds the control mappings), ADR-0046 (review workbench — sign-offs ride the one queue)
- **Standards alignment**: NIST AI RMF (Govern/Map/Measure/Manage), ISO/IEC 42001 (AI management
  system) — explicitly, because regulated buyers ask for it by name.
- **Pillars**: 1 (governance — a new gating rung), 3 (compliance cascade)
- **Migration**: **0057** (`0057_model_risk_management`) — see the implementation amendment at the
  bottom of this file for what actually shipped, what is genuinely enforced, and what is a
  structural record only.

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

---

## Implementation amendment — 2026-08-02 (migration 0057)

Accepted and built. This section records what shipped, where it deviates from the proposal above,
and — most importantly — **which parts of this registry are genuinely ENFORCED and which are a
structural record only**. Read the honesty section before treating a green model card as an
assurance about a model.

### What shipped

**Migration 0057 (`0057_model_risk_management`)** — three tables plus two `org_settings` columns:

- `model_cards` — one risk position on one (model, intended use). `agent_id` **xor**
  `custom_provider_id` is a DB CHECK (the ADR-0034 discriminated-union discipline), and two partial
  unique indexes make `(subject, intended_use)` unique — a second risk position on the same purpose
  would make "is this model approved for X" ambiguous, and an ambiguous gate is not a gate.
  `data_claims`, `bias_fairness` and `standard_refs` are jsonb.
- `model_card_approvals` — the sign-off CHAIN. `approval_id` points at a row in the **one**
  `approvals` table. A recertification is a NEW row whose `supersedes_id` names the record it
  replaces; the replaced record becomes `superseded` when the new one is granted, so there is never
  a window with no risk position and never an edited-in-place acceptance. A partial unique index
  allows at most one `pending` request per card.
- `model_card_evidence` — an ADR-0044 `eval_runs` reference or an external report. The eval-run FK
  is **ON DELETE RESTRICT**: a run cited as the measured evidence behind a signed risk decision
  cannot be deleted out from under it, the same reasoning migration 0056 used for a scored dataset
  version.
- `org_settings.mrm_enforced` (default **false**) and `org_settings.mrm_expiry_warn_days`
  (default 30).

New `approvals.object_type` value `model_card` and new `audit_log.object_type` value `model_card` —
both plain-text columns with no CHECK, so **no DDL**, the pattern ADR-0024/0034/0044 established.
No new queue, no new ledger.

**`packages/shared/src/mrm.ts`** — the pure half: `effectiveApprovalStatus` (which recomputes
expiry from `valid_until` rather than trusting the stored status), `cardState`,
`assessBiasFairness`, `assessCardCompleteness`, `evaluateMrmGate` (the dispatch decision), and
`mrmPosture` (the honest declared-vs-enforced label). No db, no clock of its own, no provider.

**`apps/gateway/src/mrm.ts`** — the registry API, the sign-off that rides the one Approvals Queue,
the evidence links, the expiry sweep, the enforcement toggle, and `mrmDispatchGate`.

**`apps/gateway/src/agents-connectors.ts`** — the gate is a rung inside `executeGovernedDispatch`,
placed after the caller's entitlement decision and **before any provider work, cost, PII or
guardrail processing**, so a refusal costs nothing.

**`apps/gateway/src/app.ts`** — `applyModelCardApprovalDecision` is called from inside the ONE
`POST /v1/approvals/:approvalId/decide` transaction, so MRM sign-offs inherit every
separation-of-duties guard the queue already applies (named approver, admin-override reason,
self-review reason, ADR-0022 delegation) rather than growing their own. The inbox labels a
`model_card` row from the same `stageId` sentinel slot infra/conflict rows use.

**SPA** — `/admin/model-risk` under Governance: the computed posture banner, the expiring/lapsed
worklist first, card authoring, the bias/fairness slots rendered **with the disclaimer beside the
count**, evidence attachment, and the sign-off REQUEST. There is deliberately **no approve button
on that page** — the decision happens in the Approvals Queue.

### Deviations from the proposal above

1. **The refusal is one error code with three ruleIds, not one rule.** §4 named a 409
   `mrm_approval_required` with `ruleId: mrm-approval-required`. What shipped keeps that single
   caller-facing error code (the remediation is identical) but audits three distinguishable
   outcomes: `mrm-no-card` (never reviewed for any purpose), `mrm-approval-required` (a card
   exists, no acceptance), and `mrm-approval-expired` (an acceptance LAPSED). "Never reviewed" and
   "review lapsed" are very different operational stories and an operator reading the audit trail
   should not have to guess which one happened. `mrm-approval-revoked` is a fourth.
2. **The status enum gained `denied` and `superseded`.** §3 proposed
   `draft|pending|approved|expired|revoked`. A refused sign-off request and a withdrawn acceptance
   are different facts, and a recertification needs somewhere to put the record it replaced. Both
   are DB-CHECKed.
3. **A sign-off must carry a recertification date, or explicitly say it never expires.** The API
   refuses a sign-off with neither (`acknowledgeNoExpiry` must be typed out). A never-expiring risk
   acceptance is precisely what recertification exists to prevent, so it is available but never the
   default.
4. **THE GATE GOVERNS THE SERVED AGENT, NOT THE REQUESTED ONE.** Pillar-6 routing can serve a
   different registry entry than the one named in the URL. The gate runs inside
   `executeGovernedDispatch` against `served`, so the card that matters is the card on the model
   that actually ran. Gating the requested-but-not-served agent would have been a hole. This is not
   in the proposal because the proposal did not consider routing; it is the only correct reading.
5. **`standard_refs` is jsonb, not `text[]`** — same reasoning as ADR-0044's amendment: every array
   in this schema is jsonb, and one native array would be the only place a reader switches idioms.
6. **The compliance-cascade coupling (§4, last sentence) did NOT ship.** `mrm_enforced` is an
   org-wide toggle today. A compliance classification does not yet raise it per-project, and the
   ADR-0021 ceiling therefore does not apply to it. This is a real gap against §4 and is listed as
   a follow-up rather than hidden.

### What is GENUINELY ENFORCED vs. what is a STRUCTURAL RECORD

**Genuinely enforced — real behaviour, asserted end to end against the dispatch outcome:**

- **The dispatch gate refuses.** With `mrmEnforced` on, `POST /v1/agents/:id/invoke` on a model
  with no live sign-off returns **409 `mrm_approval_required`** with **zero recorded provider
  calls** (a recording spy wraps the provider), and the refusal lands in `audit_log` as
  `object_type: model_card`, `effect: deny`, with the stable ruleId for its case. The tests assert
  the HTTP outcome and the spy, never a flag on a row.
- **EXPIRY IS A CONTROL, NOT A BADGE.** This is the point of the slice and it is proved the
  awkward way: the test sets `valid_until` into the past **without running the sweep**, asserts the
  stored status is still `approved` (a deliberately stale cache), and then asserts the dispatch is
  refused anyway with `mrm-approval-expired`. The gate recomputes `valid_until < now` on every
  call, so a lapsed certification stops dispatch in a deployment that never runs the sweep at all.
  A registry whose expiry depended on a scheduler nobody runs would be decorative.
- **The toggle is reversible.** Turning `mrmEnforced` back off restores dispatch with every card,
  sign-off and evidence row intact — ADR-0024's `key_custody_enforced` property, deliberately
  copied rather than reinvented.
- **Sign-off rides the ONE queue.** A sign-off request creates a real `approvals` row
  (`objectType: 'model_card'`), it appears in the named approver's ordinary inbox with a label,
  a non-approver is refused with the queue's own `not_the_named_approver`, and the acceptance is
  recorded only through `POST /v1/approvals/:id/decide`. There is no second decide path.
- **Recertification is a chain.** After a lapse, a new sign-off restores dispatch, the lapsed
  record survives as `expired`, and exactly one record is `approved`.
- **Evidence cannot dangle.** Attaching a nonexistent eval run is a 404; attaching the same run
  twice is a 409; and the database itself refuses to delete an eval run that is cited as evidence
  (asserted by attempting the delete and expecting it to throw).
- **The registry is admin-gated.** Every `/v1/mrm/*` route 403s for a non-admin. The one thing a
  non-admin does — decide their own sign-off — happens on the pre-existing approvals route.

**Structural record only — real state, real lifecycle, but NOT a measurement:**

- **BIAS AND FAIRNESS ARE DECLARED, NEVER MEASURED.** `bias_fairness` is a list of
  `{dimension, method, resultRef, status, assessedAt, assessedBy}` slots. The platform records
  them, reports which are missing/unevidenced, and refuses to call a card complete when the list is
  empty — because "we did not look" must not read the same as "we looked". It does **not** run a
  fairness test, and it cannot: measuring bias requires dispatching a model against a purpose-built
  dataset, and **no model provider is connected in this deployment** (the owner's key is parked and
  was not used; everything here ran against the in-memory mock). This slice ships the **governance
  wrapper and the evidence-attachment path**, not automated bias measurement. The disclaimer string
  is returned by the API and rendered next to the count in the SPA, so the number cannot be
  mistaken for a measurement by anyone reading the screen either.
- **Standards alignment is a mapping, not a certification.** `standard_refs` lets an auditor follow
  `nist-ai-rmf:MEASURE-2.11` to a card. It does not make RegulAIt or its customer certified against
  NIST AI RMF or ISO 42001, and the SPA says so in those words.
- **Cards are human work.** An empty registry enforces nothing whatever the toggle says — the
  `absent` posture label says exactly that. The platform can require and expire a card; it cannot
  author one.
- **The expiry SWEEP has nothing driving it.** `POST /v1/mrm/expiry-sweep` refreshes the stored
  status of lapsed records and audits each flip, but **there is no in-process scheduler or job
  runner in this codebase** and nothing calls it on a timer. An operator or an external cron must.
  This is survivable only because enforcement deliberately does not depend on it (see above); the
  sweep is a display/consistency job, the gate is the control. Stated plainly rather than described
  as "a scheduled sweep", which would be a lie.
- **Warning ahead of a lapse is a LIST, not a notification.** `GET /v1/mrm/expiring` and the SPA
  panel surface upcoming and past lapses as work. Nothing pushes that anywhere — no email, no
  Slack, no findings row. §Consequences' "the expiry sweep must warn well before `valid_until`" is
  therefore delivered as a pull surface, not a push one.

### Verification performed

- Migrations 0001–0057 apply clean to a fresh database.
- `pnpm -r build` clean; web bundle builds clean.
- `packages/shared`: 50 → 86 tests, all passing (36 new pure MRM cases).
- Full gateway suite: **1247 → 1281 tests, all passing** (34 new integration cases in
  `apps/gateway/src/mrm.test.ts`), run against a freshly created database. The suite mutates the
  `org_settings` singleton (`mrmEnforced`), so `afterAll` restores the exact pre-existing values and
  deletes every card it created — a leaked enforced toggle would fail every other dispatch suite in
  the run.
- `policy-kernel`: 129, unchanged. `workflow-kernel`: 39, unchanged.

### Follow-ups this slice leaves open

- **Per-project enforcement via the compliance cascade** (§4's last sentence, and the ADR's own
  open question) — `mrm_enforced` is org-wide only today.
- **Nothing drives the expiry sweep**, and nothing pushes an expiring-soon warning anywhere.
- **Bias/fairness measurement** — out of scope by design here; it needs a connected provider and a
  purpose-built dataset, and it would be a large ADR of its own.
- ADR-0058's control catalogue, which `standard_refs` is meant to resolve against, does not exist
  yet — the refs are free-form strings until it does.
