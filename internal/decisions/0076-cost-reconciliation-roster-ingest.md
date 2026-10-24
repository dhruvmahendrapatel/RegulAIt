# ADR-0076: Scheduled cost reconciliation + roster ingest — defending the pillar-5 wedge

- **Status**: Accepted
- **Date**: 2026-08-15
- **Migration**: 0085
- **Driver**: [MARKET_ANALYSIS_2026-08.md](../product/MARKET_ANALYSIS_2026-08.md) §4 item 3 —
  "defend the P5 wedge before the neighbors arrive". Torii/Zylo's pitch is "we poll your SSO and
  finance feeds"; this ADR adds the operator-run reconciliation cadence and the SSO-roster
  adapter while keeping ADR-0069's metered/imported spine — and its no-credential posture —
  intact.
- **Extends**: [ADR-0069](0069-cross-vendor-cost-consolidation.md) (the imported ledger and the
  disclosed gaps this closes), [ADR-0064](0064-in-process-scheduler.md) (the job contract),
  [ADR-0042](0042-guardrail-engine.md) (the ingest PII posture)

## Context

ADR-0069 shipped cross-vendor cost consolidation with two gaps it disclosed itself:

1. **Cross-chunk double-counting.** The byte bounds force a large CUR to be chunked by the
   operator, and "two overlapping chunks of the same CUR are two batches with different
   fingerprints and will double-count. The fingerprint guard catches identical bytes only."
   That is a wrong chargeback presented confidently — the exact failure the slice was built to
   refuse — reachable by an ordinary operator mistake, and correctable only by noticing it.
2. **One-at-a-time identity mapping.** Per-user attribution of imported spend runs on
   admin-asserted aliases and person-level cost centres, asserted one HTTP call each. A real
   customer has two hundred of them, already sitting in their identity system's export.

Both matter now for a market reason: the SaaS-management incumbents (Torii, Zylo) sell exactly
"we poll your SSO and finance feeds", and the metered+imported join is the part of pillar 5
nobody else ships. The wedge holds only if the imported side stays trustworthy at real scale.

## Decision

### 1. Scheduled reconciliation (the eighth ADR-0064 job)

A reconciliation pass over `imported_cost_lines` that **marks — never deletes —** cross-batch
duplicates of the same vendor fact, where a *vendor fact* is the full identifying tuple
(vendor, account, billing kind, service, currency, exact period window, exact amount):

- **Newest restatement wins.** When several applied batches carry the same fact at the same
  multiplicity, the most recently applied batch's copies stay live and every older copy gets
  `superseded_at` + `superseded_by_line_id` + `superseded_run_id` + a stated
  `superseded_reason` (migration 0085; a DB CHECK makes a mark without a reason impossible,
  and a line can never supersede itself).
- **Two refusals, structural.** Batches that disagree about a fact's **multiplicity** are
  reported (`ambiguous_multiplicity`) and left alone — a guessed dedup is a guessed invoice.
  **Overlapping-but-not-identical** windows (same account/service/kind, intersecting periods,
  different amounts) are reported (`overlapping_window`) and left alone — a partial-period
  restatement is an operator decision, and the correction path is ADR-0069's existing one:
  revoke the wrong batch, re-import.
- **The consolidated read excludes marked lines and DISCLOSES the exclusion** — a
  `reconciliation` block with the excluded count and the last pass time. A number that
  quietly got smaller is the same disease as a number that quietly doubled.
- **Revoking a superseding batch REINSTATES what it superseded**, in the same transaction and
  audited: a withdrawn restatement must not erase the fact it restated.
- **Delivery**: `cost-reconciliation-sweep` in the ADR-0064 registry (daily default; runs only
  while the scheduler is on — off by default everywhere, per that ADR), plus
  `POST /v1/cost-imports/reconcile` (run-now, the identical function) and
  `GET /v1/cost-imports/reconciliation` (health/report: last pass, standing counts, the
  superseded lines themselves, the refused-to-decide warnings). Both admin-only through the
  default gate. Every pass writes a `cost_reconciliation_runs` ledger row (open-first, like
  `scheduler_runs`); every supersession group and every pass writes `audit_log`
  (`cost-reconcile-superseded` / `cost-reconcile-completed` / `cost-reconcile-reinstated`).
- **Still no polling.** ADR-0069's posture is untouched: no vendor credential, no scheduled
  re-import. The sweep re-examines rows we already hold.

### 2. Roster ingest (the SSO-roster adapter)

`POST /v1/cost-imports/roster` consumes a **SCIM-style user export (JSON)** or a **CSV
roster** and turns it into vendor-account aliases + person-level cost centres — **through the
existing write paths, never a parallel one**: the single-alias route and the roster loop both
end in the same `upsertAliasCore` / `setCostCenterCore` functions, the roster's aliases appear
on the existing mappings surface, its per-row mutations audit under the existing ruleIds
(`cost-import-alias-created`, `cost-import-user-cost-center-set`, marked `origin: roster`),
and one re-resolution pass at the end re-attributes stored lines exactly as a hand-asserted
alias would.

- **Ambiguity is refused loudly.** One vendor account mapped to two people refuses every
  involved row, names both, and writes nothing for that account. One person given two cost
  centres: same. An email naming no RegulAIt user is refused per-row — a roster never invents
  a person. Header inference that finds two plausible account columns refuses the whole file
  and asks for an explicit mapping. `rows_parsed = accepted + refused` holds throughout.
- **PII posture is ADR-0069's, restated** (`ROSTER_PII_POSTURE`): account and email columns
  are identity join keys, exempt by the disclosed construction; the one retained non-identity
  field (cost centre) goes through the same ADR-0042 scan (`scanFreeTexts`, the same function
  the import scan now uses) at a mode composed MAX with the org/compliance floor, counts only;
  every unmapped SCIM attribute (display names, phones, manager chains) is discarded at parse.
- **Dry-run first-class**: the full plan (create/update/unchanged/unnecessary, cost centres to
  set), zero writes, audited as `cost-import-roster-planned`. Apply audits a summary
  (`cost-import-roster-applied`) with the re-resolution blast radius. A required, audited
  `reason` is stamped on every asserted alias — a bulk assertion nobody has to justify is two
  hundred assertions nobody can review.

### 3. Surface

The existing `/admin` cost-consolidation page gains a reconciliation card (status, last pass,
superseded lines with their reasons, refused-to-decide warnings, run-now) and a roster-upload
card (file/paste, dry-run/apply, refusals by row, both postures verbatim). The consolidated
card discloses the excluded-duplicates count inline.

## Proof (the failing-first evidence)

`cost-reconcile.test.ts` opens by **asserting the defect exists**: two overlapping chunks
applied through the real API make Jane's imported figure 66.66 where the vendor charged 33.33
— the non-vacuity control. With the read-side exclusion deliberately disabled, the invariant
tests go red (verified during development); with it enabled, the same read returns 33.33 after
the pass, all three lines still exist, the marked one names its replacement/run/reason, and
the response disclosed the exclusion. `roster-ingest.test.ts` opens the same way: the seat
line resolved to NOBODY before the roster, and to the right human by `admin_alias` after —
with the ambiguity wall disabled, the two-people refusal test goes red (also verified).

## Consequences

- The wedge's imported side survives the two most likely operator mistakes (overlapping
  chunks, unmapped accounts at scale) without importing the incumbents' posture (credentials,
  polling) — the analysis's "keep the metered/imported spine intact" constraint.
- One more monotonically growing table (`cost_reconciliation_runs`) and four columns on
  `imported_cost_lines`; the supersession CHECK is one more thing a future writer must satisfy.
- **Honest limits, disclosed rather than closed**: reconciliation matches EXACT tuples only —
  a duplicate that differs by a cent, a re-dated window or a renamed service is a warning, not
  a mark (deliberate, but it means real CUR re-exports with reprocessed amounts still
  double-count until an operator revokes); the fact key treats `service = NULL` and equal
  amounts as identity, so two genuinely distinct same-priced charges for the same account,
  window and kind that arrive in different batches would be wrongly marked (the vendor's own
  line granularity is the mitigation, and nothing is lost — the mark is reversible by revoke);
  warnings stored per pass are bounded at 200 (counts stay honest); the roster clears no cost
  centre (absence ≠ clearing, an explicit PUT remains the way to clear); SCIM is consumed as a
  file, not as a live SCIM endpoint (that would be a credential decision, ADR-0034/0063
  territory); no staleness SLO alerting was added (the consolidated view already reports
  per-vendor staleness; alerting on it is Approvals-Queue work the analysis left optional);
  and the scheduled cadence runs only where the ADR-0064 scheduler is on, which is off by
  default everywhere — stated on the health read.
- Test movement: gateway 115 → 117 files (+21 tests: 11 reconciliation, 10 roster); shared
  +20 (planner + parser units); scheduler registry pin updated for the eighth job.
