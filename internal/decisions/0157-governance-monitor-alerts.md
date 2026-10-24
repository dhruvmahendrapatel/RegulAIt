# ADR-0157: Governance Monitor — Rule-Based Alerts Over the Standing Picture

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0156 (dependency graph), ADR-0148 (trust coverage), ADR-0147
(control links), ADR-0089 (agent ownership), ADR-0045 (model-card approvals),
ADR-0064 (scheduler); ROADMAP §9 Phase 3 "Real-time compliance monitoring and alerts"
Migration: 0124 (`governance_alerts`)

## Context

Phase 3 ("Monitor & Respond") had a posture report, a trust dashboard and
spend alerts, but nothing that noticed when the governance picture of a
system in production got worse: a vendor turning high-risk under an approved
use case, an agent halted or orphaned while a use case still depends on it,
a high risk with no control. Every one of those was visible to someone who
went looking, and to no one who did not.

## Decision

1. **Seven rules**, pure and unit-tested (`packages/shared/src/governance-monitor.ts`):
   `use_case_inherited_high_risk` (high), `use_case_agent_halted` (high),
   `use_case_vendor_unapproved` (medium), `use_case_agent_unowned` (medium),
   `use_case_agent_no_approved_model_card` (medium), `high_risk_without_control`
   (high), `dimension_coverage_below_floor` (medium, floor 50%).
2. **Use-case rules fire only for APPROVED use cases** — the ones in
   production. A proposal with a halted agent is a review comment; an
   approved system with one is an incident.
3. **Dependencies are transitive over the ADR-0156 graph**, observed edges
   included; agent and vendor conditions are keyed by the
   (use case, dependency) pair, so one bad agent under two use cases is two
   conditions with two owners.
4. **One row per condition EPISODE** (`governance_alerts`): a partial unique
   index allows one active (open/acknowledged) row per (rule, subject).
   Persisting → refreshed in place, status untouched (an acknowledgement
   survives); cleared → resolved; recurrence → a NEW row. Concurrent passes
   dedupe on the index (`ON CONFLICT DO NOTHING`).
5. **Acknowledge needs an identity and a note** (1–500 chars); resolved alerts
   cannot be acknowledged (409). There is no "dismiss": an alert ends when its
   condition ends.
6. **Delivery is the audit log**: `governance-alert-raised`, `-resolved`,
   `-acknowledged` and one `governance-monitor-evaluated` row per pass. Every
   SIEM stream that reads the audit log receives alerts without a second
   delivery path.
7. **Driven two ways, one implementation**: scheduler job
   `governance-monitor-sweep` (hourly default, admin-tunable) and
   `POST /v1/governance/monitor/evaluate`. `GET /v1/governance/alerts`
   lists them. All admin-only.
8. **A monitor, not a control.** No dispatch decision reads these rows;
   enforcement (MRM gate, halts, entitlements) is unchanged and independent.

## Consequences

- Unmeasured trust dimensions do not alert — that would fire on every fresh
  install. They stay a labelled gap on the dashboard.
- The coverage floor is a constant today; making it a per-org setting is a
  follow-up if an owner asks.
- No escalation into the approvals queue yet: an alert is information for an
  owner, not a decision someone must take. Routing high alerts to a named
  approver is a candidate follow-up.

## Tests

`packages/shared/src/governance-monitor.test.ts` (8: clean case, inherited
path labels, approved-only scope, pair keys, decided risks excluded, measured
dimensions only, reconcile raise/refresh/resolve, unevaluated rules never
resolve). `apps/gateway/src/zz-adr0157-governance-monitor.test.ts` (5: raise
with evidence + negative controls, acknowledge 403/400/404/200 and survival,
resolve + 409 + new episode on recurrence, concurrent passes, admin-only +
scheduler registration).
