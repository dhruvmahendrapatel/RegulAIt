---
phase: bootstrap-complete
last_updated: 2026-07-22
active_epics: [EPIC-02, EPIC-03]
open_questions_open: []
last_session: sessions/2026-07-21-session-01.md
---

# RegulAIt — Project State

## Where we are (read this paragraph first)
The infrastructure bootstrap phase (EPIC-01) is **complete**. The private GitHub repo
[dhruvmahendrapatel/RegulAIt](https://github.com/dhruvmahendrapatel/RegulAIt) is live with the
full scaffold. AWS is a two-account Organization (Management `913436627353` / Workload
`regulait-dev` `517506432475`), IAM Identity Center only (no long-lived keys), and the full
security baseline — org-wide CloudTrail, GuardDuty, Security Hub (FSBP + CIS standards), AWS
Config with a cross-account aggregator, account-level S3 Block Public Access, a $5/month Budget,
3 SCPs, and all three permission sets (`Admin-BreakGlass`, `Deploy-Builder`, `ReadOnly-Audit`) —
is applied via Terraform (`terraform plan` reports zero drift). The `github-oidc-role` module is
authored but intentionally not wired into `main.tf` yet — no workload exists to deploy.
Full narrative, including two real incidents worth reading before touching this infra again, is
in `sessions/2026-07-21-session-01.md`.

**No product code exists yet.** EPIC-02 (governance layer) and EPIC-03 (workflow engine) are the
next phase, per the specs in `docs/product/`.

## Epics
| ID | Name | Status | Related |
|---|---|---|---|
| EPIC-01 | Bootstrap: AWS foundation + GitHub repo + session-continuity scaffold | **done** | ADR-0001–0004 |
| EPIC-02 | Governance layer MVP | not started | GOVERNANCE_LAYER_SPEC.md |
| EPIC-03 | Workflow engine MVP | not started | WORKFLOW_ENGINE_SPEC.md |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | **applied**, zero drift | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | **applied** (Admin-BreakGlass imported from its manual bootstrap creation, other two created by Terraform) | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | **live and private**: https://github.com/dhruvmahendrapatel/RegulAIt | EPIC-01 |
| COMPONENT-05 | Admin portal | not started | EPIC-02 |
| COMPONENT-06 | Policy/allow-list engine | not started | EPIC-02 |
| COMPONENT-07 | Workflow orchestrator | not started | EPIC-03 |

## Decisions
See [docs/decisions/README.md](../docs/decisions/README.md) for the full ADR index. All four
seed ADRs (0001–0004) are Accepted.

## Open Questions
None open. OQ-001 (region allowlist) defaulted to `["us-east-1", "us-east-2"]` and is applied as
the region-allowlist SCP; OQ-002 (budget cap) resolved to $5/month; OQ-003 (GitHub account)
resolved to personal `dhruvmahendrapatel`.

## Known follow-ups (not urgent, not blocking)
- Security Hub's default standards enabled **both** AWS Foundational Security Best Practices and
  CIS AWS Foundations Benchmark v1.2.0 (the latter wasn't explicitly requested — AWS enables it
  by default alongside FSBP). Harmless; disable the CIS subscription later if its findings become
  noise.
- `infra/modules/aws-security-baseline`'s Config aggregator authorization assumes `us-east-1`
  only (single-region aggregation) — revisit if resources start landing in `us-east-2`.
- The forecasted (not actual) monthly spend shown in `aws budgets describe-budgets` was ~$1.21 at
  last check — almost entirely the two KMS CMKs (state bucket + CloudTrail). Nothing alarming
  against the $5 cap, but worth a glance next session.

## Standing guardrail
Nothing gets a "production" designation, and nothing deploys to one, without the user's direct,
explicit sign-off in that session. See [CLAUDE.md](../CLAUDE.md).
