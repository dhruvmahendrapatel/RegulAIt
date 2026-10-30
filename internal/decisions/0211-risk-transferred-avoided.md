# ADR-0211: Transferred and avoided risk treatments

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

PENDING P17 (owner, 2026-10-29; started in wave 1 on 2026-10-30, #453 comment 6522850568). The AI risk register
(ADR-0081, ADR-0147, ADR-0180 §6) lets a risk be `open`, `mitigating`, `accepted` or `closed`. Risk-management
standards also expect two more treatments:

- **transferred**: the cost of the harm is carried by someone else, for example an insurer or a supplier under a
  contract;
- **avoided**: the use that created the risk stopped.

The ADR-0180 acceptance record already has a `transfer` response type, but that records an *acceptance* whose
rationale is a transfer; it does not let the register say that a risk is transferred, and nothing records avoidance.

Open source first (ADR-0176): this is our own register's status vocabulary and its audit record, which is the
governance semantics ADR-0176 §4 reserves for us. No library models it.

## Decision

1. **Two more statuses, nothing else changes meaning.** `ai_risks.status` gains `transferred` and `avoided`
   (migration 0229, hand-written). `open`, `mitigating`, `accepted` and `closed` keep exactly their meaning and their
   transitions. "Live" stays `open` or `mitigating` everywhere it is counted.
2. **A treatment is a record, not a flag.** Each needs **evidence** (for a transfer, the contract or policy reference;
   for an avoidance, the decision that stopped the use; 1–2000 characters) and an **accountable owner**. The row stores
   the evidence, the owner, who recorded it and when (`treated_at` on the database clock). A CHECK makes a treated row
   without evidence, or evidence on an untreated row, a database error, as `ai_risks_acceptance_check` does for
   acceptance. The evidence column is registered with the ADR-0102 prose scrub.
3. **One write path, through the register.** `POST /v1/risks/:riskId/treatment` with `{treatment, evidence,
   ownerUserId}`. Object-level rules are the transition's: the risk's owner or an admin. A non-admin may name only
   themselves as the owner (the rule `POST /v1/risks` already applies); the owner must be an existing user. Only an
   `open` or `mitigating` risk can be treated. The row and its audit row (`risk-transferred` / `risk-avoided`) are
   written in one transaction, and the audit row freezes what every evidence resolver measured at that moment, as
   acceptance does. `POST .../transition` refuses the two statuses by name (422), as it refuses `accepted`.
4. **Default off (ADR-0180).** `org_settings.risk_treatments_enabled` defaults to `false`. While off, a treatment is
   refused (409 `risk_treatments_off`) and the refusal is audited (`risk-treatment-refused`). It is set only by its
   own admin-only route, `PUT /v1/org/settings/risk-treatments`; turning it on is a `settings_relax` step-up and is
   audited with the old and new value in the same transaction. Turning it off leaves recorded treatments as they are.
5. **A treated risk is a decided record.** It cannot be edited, have its residual or controls changed, be treated
   again, or be accepted (409 `risk_treated`, on the register, the acceptances route and a use-case sign-off). It moves
   on only by an audited transition: back to `open` (the contract lapsed, the use resumed) or to `closed`. That
   transition clears the treatment columns, and its audit row keeps the ended treatment (`endedTreatment`).
6. **What each treatment means for the numbers.**
   - **Transferred keeps its rating.** A contract moves who pays, not whether the harm can happen. A transferred risk
     stays in the heat maps, the dependency graph and the residual-tolerance position, exactly as an accepted one does.
   - **Avoided leaves the ratings**, as a closed risk does: it is excluded from the heat maps, the dependency graph and
     the tolerance position.
   - The trust dashboard's partition becomes found = mitigated + accepted + transferred + avoided + unmitigated
     (`risksTransferred`, `risksAvoided`; per-dimension counts carry both). The posture report counts both. The
     use-case overview shows the treatment evidence beside the status. The audit export and signed bundle carry the new
     audit rows unchanged.
7. **Where it lives in the product.** In the risk detail on the Risks page, beside the existing status actions (the
   placement note on #453, comment 6522922046). The switch sits in Settings → Organisation after the continuous-assurance
   gate.

## Consequences

- A transferred risk with a residual above tolerance still holds the deploy gate until it is reopened and accepted, or
  its residual is declared lower before the transfer. That is deliberate (secure by default): a transfer does not make
  the harm less likely.
- Risk owners who are not admins can use the treatment endpoint through the API; the Risks page itself is in the admin
  console, so in the product an admin records it, choosing the owner from the people list.
- Reports from before this change have no `transferred` or `avoided` keys; the web treats them as zero.

## As built

- Migration 0229 (`0229_risk_transferred_avoided.sql`): the status CHECK, four columns, two FKs (SET NULL), the
  treatment CHECK and the `org_settings` column. Journal `when` 1785164000000.
- Gateway: `risks.ts` (treatment route, transition and detail), `risk-treatment-settings.ts` (the switch),
  `risk-tolerance.ts` and `use-cases.ts` (acceptance refusals, avoided out of the position), `trust-dashboard.ts`,
  `posture.ts`, `use-case-overview.ts`.
- Shared: `AI_RISK_TREATMENTS`, `LIVE_RISK_STATUSES`, `isTreatedRiskStatus`, `riskStatusCarriesRating`,
  `recordRiskTreatmentSchema`, `setRiskTreatmentsEnabledSchema`; `effectiveRiskRating` drops avoided risks.
- Web: `RiskTreatmentPanel.tsx` (the form and the record), `RisksPage.tsx`, `TrustDashboardPage.tsx`,
  `PosturePage.tsx`, `OrganizationPage.tsx`.
- Tests: `zz-adr0211-risk-treatment.test.ts` (gateway, against Postgres), `zz-b4a-relax-routes.test.ts` (the switch
  needs a step-up to turn on), `prose-scrub.test.ts`, shared `risks.test.ts` and `dependency-graph.test.ts`, and
  `e2e/adr0211-risk-treatment.mock.spec.ts`.
