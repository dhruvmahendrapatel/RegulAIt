# ADR-0047: Executive & compliance reporting — read-only, entitlement-scoped board dashboards and scheduled exports over the existing cost/audit/workflow data

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0059)
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

## Implementation amendment — 2026-08-02 (migration 0059)

Accepted and built. This section records what shipped, where it deviates from the proposal above,
and — most importantly — **what is genuinely enforced versus what has nothing driving it**. Read
the honesty section before assuming a scheduled export lands in anyone's inbox. It does not.

### What shipped

**Migration 0059 (`0059_executive_reporting`)** — three tables and **no rollup/materialization of
any kind**:

- `report_definitions` — `kind` ∈ `exec_summary | team_scorecard | compliance`, `scope_kind` ∈
  `org | initiative | team | project` with `scope_id`, `period`, `sections`, `format`, and the
  load-bearing `entitlement_scope` ∈ `org | team | project`. Two DB CHECKs carry the design: an
  org-scoped definition takes **no** `scope_id` and every other scope **requires** one; and
  `entitlement_scope='org'` is only permitted on an org-scoped definition, so "narrow report,
  org-wide grant" is not expressible.
- `report_schedules` — `cadence` ∈ `daily | weekly | monthly | quarterly`, `enabled`,
  `recipient_user_ids`, `last_generated_at`, `last_run_id`. **A schedule DEFINITION only.**
- `report_runs` — one immutable row per generation, carrying the resolved period, the format, the
  payload, and — the honest record — `entitlement_scope` **copied at generation time** plus
  `effective_project_ids`, the exact set the generator was permitted to query (`NULL` = org-wide).
  Copying the scope is what stops a later edit to the definition from retroactively widening who
  may read an already-generated artifact.

New `audit_log.object_type` value `report` (plain text, no DDL), with stable ruleIds:
`report-definition-created`, `report-definition-deleted`, `report-schedule-created`,
`report-schedule-updated`, `report-schedule-deleted`, `report-schedule-swept`, `report-generated`,
`report-exported`, `report-read-denied`, `report-export-denied`, and the refusal family
`report-access-denied-{org-scope,not-team-member,not-project-member,no-visible-projects,
scope-mismatch,no-identity}`.

**`packages/shared/src/reporting.ts`** — the pure half: `resolveReportPeriod` (half-open UTC
windows, so two machines from the same ledger cannot produce different numbers), the section
assembly, `assessControls`, the CSV render/parse pair, `scheduleIsDue`, and — the important one —
**`evaluateReportAccess`, which returns the exact project-id set a generation may query rather than
a boolean.**

**`apps/gateway/src/reporting.ts`** — `resolveScopeProjectIds` (definition scope → project ids,
never consults the caller), `computeReport` (the ledger queries), `generateReport` (decision +
compute + run row + audit), `canReadRun`, and the API.

**SPA** — `/admin/reports` under Governance, next to the Audit log.

### §4 is implemented as a query-construction narrowing, not a filter

This is the thing the ADR said the reviewer must check, so it is stated concretely. Scoping is a
**two-step, two-function** design:

1. `resolveScopeProjectIds` answers *"which projects does this DEFINITION cover"* and never looks at
   the caller.
2. `evaluateReportAccess` answers *"which of those may THIS caller see"* and returns ids.

Every ledger query in `computeReport` is then built **from those ids** — `inArray(usage_events.
project_id, ids)`, a jsonb `detail->>'projectId' = ANY(...)` predicate on `audit_log`, and a
member-id predicate on `approvals`. Nothing is ever computed org-wide and filtered afterwards,
because a post-hoc filter over an aggregate cannot un-aggregate it. Three further properties:

- **Admin widens WHO, never WHAT.** An admin under a *team*-scoped definition still gets the team's
  project list, not the org's. Only an admin under an *org*-scoped definition receives the
  unbounded scope (`null`), which is the sole path by which spend attributed to **no** project
  enters a report.
- **A granted report is still narrowed by membership.** A team lead entitled to their team's
  scorecard sees only the team's projects **they are a member of** — the grant chooses the report,
  membership chooses the rows.
- **An empty intersection is a 403, not a zero.** Serving an empty report would make "no visible
  data" indistinguishable from "no spend".

### Deviations from the proposal above

1. **NO PDF.** §3 names `pdf` and flags the rendering dependency as unresolved. It stays
   unresolved: the format vocabulary is `csv | json | both`, and `pdf` **is not accepted anywhere**
   rather than being accepted and quietly emitting something else. The board-ready *document* is
   therefore not built; the board-ready *data* is. Recorded as a deviation, not a footnote.
2. **NO DELIVERY, AND NO S3.** §3 says artifacts are deposited to the ADR-0035 write-only encrypted
   bucket. Nothing is written anywhere but `report_runs`. `recipient_user_ids` is stored so the
   entitlement check has something to check against; **no recipient is mailed, notified, or handed a
   file.** The concentrated-artifact risk §3 describes is therefore not yet contained by the bucket
   posture — it is contained only by the read/export authorization on `report_runs`, which is real
   and tested, and by the artifact never leaving the database on its own.
3. **The compliance control catalogue is BUILT-IN, not ADR-0058's.** §2 is explicit that this ADR
   does not own the catalogue and ADR-0058 does not exist. What shipped is the **renderer** plus
   five controls whose evidence comes from ledgers that do exist (audit rows, approvals, live MRM
   sign-offs per ADR-0045, eval runs per ADR-0044, attributed-spend rows). The gap rule is enforced:
   a control with zero evidence renders `status: 'gap'` with an explicit note, never a silent pass.
   The payload also states in-band that presence of evidence is **not** an assertion that a control
   is operating effectively.
4. **CSV does not reuse ADR-0031's streaming keyset export.** §3 says it should. A report is a
   *bounded, already-computed* artifact — tens to hundreds of rows in `report_runs.row_count`, not a
   ledger scan — so the streaming machinery would add nothing and the export writes the rendered
   payload directly. The long-format `section,key,metric,value` shape is documented and round-trip
   tested. The ADR-0031 window/ceiling disclosure is not applicable because there is no truncation
   to disclose.
5. **`workflow` section throughput comes from `approvals`, not `workflow_instances`.** §1 names
   both. Approval throughput and latency shipped; per-stage workflow-instance counts did not.
6. **Report kinds share one computation.** `exec_summary` and `team_scorecard` currently differ only
   in scope and default sections, not in the sections' contents. Honest: the "scorecard" shape is
   the same data at a narrower scope.

### What is GENUINELY ENFORCED vs. what NOTHING DRIVES

**Genuinely enforced — asserted on served payloads and persisted rows, not on UI:**

- **THE NUMBERS RECONCILE AGAINST THE LEDGER.** The reconciliation test re-queries `usage_events`
  for the exact period window, sums the rows in JS, and asserts the report's `totalCostUsd`,
  `totalEvents` and `totalInputTokens` **equal** that — per project line as well as in total. It is
  not a snapshot of whatever the code produced. If a rollup table were ever introduced and drifted,
  this fails.
- **CROSS-TEAM AGGREGATION DOES NOT LEAK.** A non-admin team lead's scorecard is asserted to contain
  exactly one project line (their own), to **omit** the other team's project id entirely, and — the
  proof it is arithmetic rather than cosmetic — its total is asserted **strictly less than** the
  total an unscoped query over both projects produces. The persisted `report_runs.
  effective_project_ids` is asserted to be that same single-element list.
- **THE ORG REPORT IS ADMIN-ONLY.** A non-admin generating an org-scoped definition gets 403 with
  `report_scope_not_entitled` and an audited `report-access-denied-org-scope` row. Another team's
  scorecard and a non-member's project report are each refused with their own ruleId.
- **ARTIFACT READS ARE SCOPED TOO.** A non-admin is refused both `GET /v1/reports/runs/:id` and its
  `/export` for an org-scoped artifact (audited `report-read-denied` / `report-export-denied`), and
  the run does **not** appear in their `GET /v1/reports/runs` list — while their own team artifact
  is readable.
- **THE EXPORT ROUND-TRIPS.** The CSV is parsed back and its `spend/total/cost_usd` cell is asserted
  equal to the payload's number, so the export cannot silently disagree with the report.
- **ADMIN GATING.** Authoring definitions and schedules, driving the sweep, and the overview are
  admin-only via the default gate; generation and artifact reads are the only non-admin routes, and
  each resolves entitlement inside the handler. A non-admin's attempt to create a definition is
  asserted to leave **no row**.
- **THE ESTIMATE LABEL IS ON THE FACE OF THE REPORT.** `spend.estimate: true` plus the
  GOVERNANCE §10.4 disclaimer ride every payload and every CSV (`meta,report,basis,estimate`).

**Nothing drives it — stated plainly:**

- **THERE IS NO IN-PROCESS SCHEDULER IN THIS CODEBASE, AND THIS SLICE DID NOT ADD ONE.** A
  `report_schedules` row is a cadence definition and nothing more. Reports are generated in exactly
  two ways: someone calls `POST /v1/reports/definitions/:id/generate`, or an operator/external cron
  calls `POST /v1/reports/schedules/run-due`. Both the sweep response and the SPA say so in those
  words, and `last_generated_at` staying `NULL` is how an idle schedule is **visible** rather than
  assumed to be working. The test asserts that creating a schedule generates nothing, that the sweep
  is what generates, and that an immediately-repeated sweep skips.
- **No artifact is delivered anywhere.** No S3, no mail, no ChatOps.
- **`initiative` scope is implemented but untested end to end** — it resolves through
  `projects.initiative_id` exactly as `team` resolves through `project_members.team_id`.
- **Retention/pruning of `report_runs` is not built.** Payloads accumulate.

### Verification performed

See the combined verification block in ADR-0048's amendment — both slices were built and verified in
one session and share one test run.

### Follow-ups this slice leaves open

- **PDF rendering** — still the unresolved dependency decision §3 flags.
- **Delivery to the ADR-0035 write-only encrypted bucket**, and recipient notification.
- **ADR-0058 compliance packs** — replace the built-in five-control set with real framework
  mappings; the renderer is ready for them.
- **A scheduler**, or a documented cron entry, for `run-due`.
- **Retention for `report_runs.payload`.**
