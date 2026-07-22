---
phase: bootstrap
last_updated: 2026-07-21
active_epics: [EPIC-01]
open_questions_open: [OQ-001, OQ-002, OQ-003]
last_session: sessions/2026-07-21-session-01.md
---

# RegulAIt — Project State

## Where we are (read this paragraph first)
RegulAIt is in its infrastructure bootstrap phase — no product code exists yet. This session
scaffolded the repo/knowledge-graph/ADR structure, installed AWS CLI and Terraform locally
(no-admin, user-scoped), and authored, formatted, and validated (`terraform validate` clean) the
Terraform for the AWS security foundation. Local repo is git-initialized with two commits but
**not yet pushed to GitHub**. Three things are blocked on the user completing manual,
browser-only steps: (1) `gh auth login` to fix an invalid cached GitHub token, before the private
repo can be created/pushed; (2) enabling AWS Organizations + creating the Workload member account
+ enabling IAM Identity Center + creating an Identity Center user with MFA + manually assigning
one bootstrap `Admin-BreakGlass` permission set — after which everything else (security baseline,
permission sets, budgets) can be applied via Terraform non-interactively; (3) running `aws sso
login` once Identity Center exists, so the agent has a working AWS session. See
`sessions/2026-07-21-session-01.md` for the full session recap.

## Epics
| ID | Name | Status | Related |
|---|---|---|---|
| EPIC-01 | Bootstrap: AWS foundation + GitHub repo + session-continuity scaffold | in progress | ADR-0001, ADR-0002, ADR-0003, ADR-0004 |
| EPIC-02 | Governance layer MVP | not started | GOVERNANCE_LAYER_SPEC.md |
| EPIC-03 | Workflow engine MVP | not started | WORKFLOW_ENGINE_SPEC.md |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | Terraform authored + validated, not yet applied — blocked on AWS manual bootstrap | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | Terraform authored + validated, not yet applied — first assignment must be manual | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | Local repo git-initialized, 2 commits, not yet pushed — blocked on `gh auth login` | EPIC-01 |
| COMPONENT-05 | Admin portal | not started | EPIC-02 |
| COMPONENT-06 | Policy/allow-list engine | not started | EPIC-02 |
| COMPONENT-07 | Workflow orchestrator | not started | EPIC-03 |

## Decisions
See [docs/decisions/README.md](../docs/decisions/README.md) for the full ADR index. All four
seed ADRs (0001–0004) are Accepted as of this session.

## Open Questions
| ID | Question | Status | Related |
|---|---|---|---|
| OQ-001 | Region allowlist for the SCP in the security baseline — which AWS region(s) should be permitted? | open | COMPONENT-01 |
| OQ-002 | Monthly AWS budget cap/thresholds for the cost-alert stack — what number? | open | COMPONENT-01 |
| OQ-003 | GitHub org vs. personal account for the repo — confirmed personal (`dhruvmahendrapatel`); revisit only if this becomes a team effort | resolved | COMPONENT-04 |

## Standing guardrail
Nothing gets a "production" designation, and nothing deploys to one, without the user's direct,
explicit sign-off in that session. See [CLAUDE.md](../CLAUDE.md).
