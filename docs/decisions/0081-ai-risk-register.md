# ADR-0081: An AI risk register whose evidence is a query over the real ledgers

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: `0087_ai_risks.sql` — one table (`ai_risks`), five FKs, no columns anywhere
  else. `ai_risk` joins the audit objectType vocabulary (plain-text column, no DDL).
- **Driver**: [GAP_ANALYSIS_CREDO_AI_2026-08.md](../product/GAP_ANALYSIS_CREDO_AI_2026-08.md)
  gap **L2** — *"We MEASURE relentlessly … but there is no RISK object: nothing links a
  measurement to a named risk scenario, a mitigating control, an owner, and a residual-risk
  acceptance."*
- **Extends**: [ADR-0058](0058-compliance-packs.md) (the evidence-is-a-query discipline and the
  `runCollector` queries this register reuses), [ADR-0080](0080-ai-use-case-registry.md) (the
  object-on-rails idiom, the owner-or-admin scoping, and the `use_case_id` reference),
  [ADR-0068](0068-redteam-depth.md)/[ADR-0067](0067-groundedness-evaluation.md)/[ADR-0042](0042-guardrail-engine.md)/
  [ADR-0071](0071-shadow-ai-format-adapters.md) (the ledgers the resolvers read).

## Context

Credo AI carries a curated agentic risk library — named scenarios, control mappings, owners,
acceptance workflows — refined over years. RegulAIt has the opposite asymmetry: the
measurements are stronger (red-team ASR with Wilson intervals, groundedness evals, guardrail
verdicts, a hash-chained denial trail), but there was no vocabulary for talking about them *as
risk*. A GRC buyer looking for "show me your prompt-injection risk, its control, its owner, and
who accepted the residual" found four excellent dashboards and no register.

## Decision

### 1. The object: `ai_risks`, lean, with the evidence deliberately absent

One table: title, description, a **category** from a curated vocabulary, owner, optional scope
references (project / agent / use case), a status lifecycle (`open → mitigating →
accepted/closed`), likelihood + impact as **declared** enums, a mitigation prose field, and the
acceptance record (who/when/why). What is conspicuously *not* there: any evidence column.
Evidence is computed at read time — there is nothing in migration 0087 an admin could set to
make a risk look measured. That is the whole differentiation from a GRC tick-box register, and
it is the ADR-0058 pattern applied to risk.

### 2. The evidence link: a fixed category → resolver mapping over ledgers that already exist

Each category maps — **in code, not per row** (`RISK_CATEGORY_EVIDENCE` in
`@regulait/shared`) — to evidence resolvers the gateway runs as real SELECTs, most of them
*through* ADR-0058's own `runCollector` rather than a second implementation:

| category | resolvers | ledgers |
|---|---|---|
| `tool_misuse` | governed_denials, abac_policies | `audit_log`, `abac_policies` |
| `prompt_injection` | redteam_asr, guardrail_config | `redteam_runs`, `guardrail_configs` |
| `data_leakage_pii` | pii_denials, pii_cascade_config | `audit_log` (`pii-*` denies), `compliance_profiles` |
| `over_permissioning` | active_grants, abac_policies | the grant tables, `abac_policies` |
| `budget_overrun` | budget_refusals (per enforcement point) | `audit_log` (budget-cap denies) |
| `hallucination` | groundedness_evals | `eval_runs` × ADR-0067 scorers |
| `shadow_ai` | shadow_findings | `shadow_ai_findings` |
| `scope_drift` | **none** | — |

`scope_drift` is in the vocabulary *because* no ledger measures it: the register answers
`evidence: "none — attestation only"` outright, the standing control case for "we don't
overclaim". The red-team resolver surfaces ADR-0068's statistics **verbatim** — pooled ASR with
its Wilson interval, trial denominator, and measurement-quality label ride together, never a
re-derived rate. A risk scoped to a project/agent narrows the queries to that slice at query
construction (the ADR-0058 scoping rule).

### 3. Measured and declared never blend

The detail response is two labelled blocks: `declared` (likelihood, impact, mitigation,
acceptance — the human's side) and `evidence` (window, per-resolver `measured` numbers, each
entry labelled `measured` / `configuration` / `none`, plus the disclaimer as a field). There is
no combined score. A 3×3 of two enums is not quantified risk math, and the register does not
pretend it is — the suite pins that no `likelihood`/`impact` key appears anywhere in the
computed side and no `score` field exists at all.

### 4. Lifecycle: transitioned or accepted, never patched

A `PATCH` naming `status` is refused by name (422 → the transition/accept endpoints);
`category` too (it is the evidence key — changing it would silently re-link the measurements);
the acceptance fields too. Transitions (`open ↔ mitigating`, either → `closed`) are an audited
endpoint with a required reason. **Acceptance is its own admin-only act** (the ADR-0080 retire
posture: signing off residual risk on the org's behalf is an org act): required note, terminal
status, and the audit row **freezes what every resolver measured at that moment** — so "what
did they accept, on what evidence?" stays answerable after the ledgers move on. Accepted and
closed rows are frozen records (edits 409).

### 5. The seed library: honest grading, control case included

`DEFAULT_RISK_LIBRARY` (@regulait/shared, zod-validated like `DEFAULT_COMPLIANCE_PACKS`) seeds
eight scenarios — one per category — each naming the mitigating control this deployment
*actually enforces*, with ADR references in prose. The schema refuses an entry whose resolvers
stray from its category's fixed mapping (no entry can shop for a flattering query), refuses
`none` hidden among real resolvers, and the shared suite pins the invariants generically so a
future entry inherits them. The library's judgments are starting *declared* positions, not
doctrine.

### 6. Surfaces

- Gateway: `GET /v1/risks/library`, `POST/GET /v1/risks`, `GET/PATCH /v1/risks/:riskId`,
  `POST /v1/risks/:riskId/transition` (all non-admin, owner-or-admin in-handler — the ADR-0080
  scoping), `POST /v1/risks/:riskId/accept` (admin, audited). All writes audit as objectType
  `ai_risk`; routes tagged in the ADR-0053 registry as `internal`.
- Web: an admin "Risks" page (governance group, beside Use cases) — library-seeded register
  form, status/category-badged list, detail with the declared-vs-evidence split and the
  transition/acceptance actions.

Non-vacuity was proven the M-002 way, both halves: constant-ify the `pii_denials` resolver →
the ledger-delta test fails; no-op the acceptance audit write → the acceptance test fails. Both
probes reverted by reversing the exact edit.

## Honest limits

- **The scores are not quantified risk math.** Likelihood × impact is two declared enums side
  by side; no number is derived from them and none should be read as exposure.
- **Evidence resolvers measure what the ledgers hold, not real-world exposure.** A quiet
  ledger is not a mitigated risk — a deployment that never ran a red-team run shows
  `runsInWindow: 0`, which the payload explicitly annotates as *unmeasured, not resisted*.
- **Nothing auto-creates risks.** Shadow-AI findings, red-team defeats, and eval regressions do
  not open register rows; every risk was registered by a person. The obvious next step —
  "a red-team defeat above threshold proposes a risk" — is named here, not silently implied.
- **Acceptance is a record, not a control.** Accepting a risk changes no enforcement anywhere;
  the endpoint says so in its response.
- **The evidence window is fixed** (90 days) rather than configurable per risk — revisit when a
  customer's review cadence disagrees.
- **Org-wide resolvers stay org-wide.** Grants and shadow-AI findings have no project scoping
  to narrow by; the evidence entry says which scope each query ran at.
