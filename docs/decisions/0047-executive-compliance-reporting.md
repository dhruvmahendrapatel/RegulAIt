# ADR-0047: Executive & compliance reporting — read-only, entitlement-scoped board dashboards and scheduled exports over the existing cost/audit/workflow data

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0019/0024 (the one `usage_events` ledger; every gateway call metered),
  ADR-0031 (streaming keyset CSV exports + `/v1/audit` cursor pagination — the export machinery this
  reuses), ADR-0032/0035 (scheduler + write-only encrypted S3 bucket posture), ADR-0022
  (approver/read visibility scoping)
- **Cross-refs (forward)**: ADR-0058 (compliance packs — the control mappings the report templates
  render), ADR-0045 (MRM — model-inventory evidence a compliance report cites), ADR-0044 (eval
  results as quality evidence)
- **Pillars**: 5 (cost dashboard — the spend data), 1 (audit — the governance data), 2 (workflow —
  throughput/SLA data)
- **Migration**: proposed and likely small (report definitions + schedule rows); no new *primary*
  data — this reads existing tables. Nothing here ships until this ADR is Accepted.

## Context

RegulAIt already holds, in structured form, the three things an executive or a compliance auditor
asks for: **spend** (`usage_events`, metered at every call per ADR-0019/0024, attributed by
project/team/cost-center per GOVERNANCE_LAYER_SPEC §10), **governance activity** (`audit_log` — every
allow/deny/approval decision), and **workflow throughput** (`workflow_instances`/`workflow_events`,
plus `approvals` for approval SLAs). What it does not have is a way to turn that into a **board-ready
artifact**: a per-team scorecard, a spend-and-controls summary, a compliance report mapping evidence
to a named control framework — on a schedule, exportable as PDF/CSV, without a human running queries.

The in-product dashboards built so far (Cost & Projects, Audit) are operational and interactive.
Executives and auditors need a different shape: a periodic, self-contained, distributable document,
and a per-team rollup that rolls *up*, not one that requires drilling into each project.

The forces that dominate the design:
- **This surface must add no authority.** A report is a strictly read-only projection of data the
  viewer is already entitled to see. But a report inherently *aggregates across teams*, which is
  exactly where a naive implementation leaks — a per-team scorecard for the whole org shows one team
  numbers from another. So the reporting entitlement must be its own explicit, scoped grant, and the
  generator must never exceed the requester's visibility (ADR-0022).
- **A scheduled PDF of the whole org's spend and audit trail is a high-value artifact.** It is
  exactly the kind of thing that must not land in an unprotected inbox or bucket. The ADR-0035
  write-only encrypted-bucket posture already exists and must be reused rather than re-decided.
- **Numbers are estimates where the underlying spend is list-price-based** (GOVERNANCE_LAYER_SPEC
  §10.4) — a board report must say so rather than imply billing-grade precision.

## Decision

Build **executive & compliance reporting** as a read-only, entitlement-scoped surface over the
existing three data sources — no new source of truth.

### 1. Report definitions and per-team scorecards

Proposed `report_definitions`: id, `kind` ∈ `exec_summary|team_scorecard|compliance`, `scope` (org /
initiative / team / project set), `period` (billing cycle / month / quarter), `sections` jsonb
(which metrics), `format` ∈ `pdf|csv|both`, `entitlement_scope` (the reporting grant required to run
or receive it), `created_by`. A **team scorecard** rolls up, per team: attributed AI spend vs budget
and forecast (from pillar 5), governance posture (allow/deny/approval-pending counts, approval SLA
adherence from ADR-0046), and workflow throughput (instances by stage, blocked-on-approval time). It
composes with Shared Projects (GOVERNANCE_LAYER_SPEC §9.5) — a shared initiative rolls up across
contributing teams while each team still sees only its own line.

### 2. Compliance-report templates over the pack control mappings (ADR-0058)

A `compliance` report is a template that, for a named framework (SOC 2, HIPAA, GDPR, ISO 27001,
NIST AI RMF, …), lists each **control** and renders its **evidence** from the platform's own data:
audit-retention configuration and actual retention, approval-gate coverage on sensitive changes,
MRM model-inventory completeness (ADR-0045), eval-quality gate results (ADR-0044), infra-ops
cert/CVE/backup ledgers (ADR-0017/0027/0035). **This ADR does not own the control catalogue** — the
compliance packs (ADR-0058) define the framework → control → evidence-query mapping; this ADR is the
renderer that executes those mappings against `usage_events`/`audit_log`/workflow data and lays the
result out as a report. A control with no evidence renders as an explicit gap, never a silent pass.

### 3. Scheduled PDF/CSV exports

- **CSV** reuses ADR-0031's **streaming keyset exports** directly — the same `(at DESC, id DESC)`
  cursor batching, the same hard row ceiling and truncation disclosure. A report is a bounded,
  labelled slice, so it inherits that machinery rather than re-implementing pagination.
- **PDF** is a rendered layout of the same computed sections. Rendering-engine choice is a **flagged
  dependency decision** consistent with this repo's supply-chain posture (ADR-0012/0034 CI notes):
  the preference is server-side templating to HTML plus a lightweight HTML→PDF path over pulling a
  heavyweight headless-browser dependency into the security-adjacent gateway; the ADR records the
  tension and defers the concrete pick to implementation review rather than pretending it is free.
- **Scheduling** uses the established scheduler posture (ADR-0032/0035): loud on failure,
  admin-visible health, ledgered runs. Generated artifacts are deposited to the **ADR-0035 pattern
  write-only, versioned, encrypted S3 bucket** (or delivered via an already-governed channel), not a
  new unprotected store — because a scheduled org-wide spend+audit PDF is exactly the exfiltration-
  worthy artifact that bucket posture was built for. Every generation is audited (proposed
  `audit_log.object_type` value `report`, plain-text column, no DDL).

### 4. Strictly read-only and entitlement-scoped — the load-bearing constraint

- The report generator issues **only read queries**; it can create no state beyond the report record
  and the emitted file. It changes nothing it reports on.
- Every figure is computed under an explicit **reporting entitlement** — a grant to see an org/team/
  initiative rollup — and the generator **never returns a number the requester's own visibility
  would not** (ADR-0022's scoping, enforced at query construction, not filtered after the fact). A
  team lead's scorecard covers their teams; only an org-level reporting grant produces an org-wide
  report. Scheduled reports carry the `entitlement_scope` of their definition and are delivered only
  to recipients holding it.
- Estimated-cost figures are **labelled as estimates** on the face of the report where the underlying
  spend is list-price-based (GOVERNANCE_LAYER_SPEC §10.4), with actual-invoice reconciliation
  labelled distinctly where a deployment has wired it.

## Consequences

### Easier
- The board/audit ask — "show me spend, controls, and workflow health, per team, for last quarter,
  as a document" — is answered on a schedule from data the platform already holds, with no analyst in
  the loop and no second reporting tool to buy.
- Compliance evidence stops being a manual screenshot exercise: a `compliance` report renders control
  coverage from the live audit/cost/workflow/MRM/eval data, so an audit is a re-run, not a project.
- Reuses proven machinery end to end (ADR-0031 streaming exports, ADR-0035 protected delivery,
  ADR-0032 scheduling) rather than minting new risky surfaces.

### Harder / given up
- **Aggregation is the leak risk, and the mitigation is real work.** Enforcing "never exceed the
  requester's visibility" at query-construction time for cross-team rollups is more careful than a
  post-hoc filter, and it is where a bug would silently over-disclose. It is the central thing the
  implementation must get right and the reviewer must check.
- **A scheduled org-wide report is a concentrated, high-value artifact.** Even inside the ADR-0035
  bucket it is a bigger single prize than any one query; delivery scope (`entitlement_scope`) and the
  bucket's no-read/no-delete grant are what contain it, and that is disclosed rather than assumed
  benign.
- **PDF rendering is an unresolved dependency decision** (§3), deliberately left to implementation
  review; a poor choice here would drag a browser engine into the gateway, which this repo's posture
  resists.
- **Reports are only as good as the evidence beneath them.** A `compliance` report cannot assert a
  control is met where the platform holds no evidence — it renders the gap honestly, which is the
  correct behaviour but means an incomplete deployment produces an incomplete report, by design.
- **Read-only means no remediation.** This surface *shows* a budget breach or a missing MRM card; it
  does not fix one. Action stays in the cost-enforcement path (pillar 5) and the review workbench
  (ADR-0046).

### Follow-up
- ADR-0058 defines the compliance-pack control catalogue and evidence-query mappings this renderer
  executes; sequence this after it.
- Settle the HTML→PDF rendering dependency in implementation review against the repo's supply-chain
  posture.
