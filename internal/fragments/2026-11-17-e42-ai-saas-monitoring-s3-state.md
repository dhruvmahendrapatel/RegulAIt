<!-- fold: state-recap -->

**2026-11-17 - E42 slice 3: optional remediation of monitored AI SaaS conversations ([ADR-0361](../decisions/0361-sanctioned-ai-saas-compliance-monitoring.md), As built slice 3; migration `pending/ai_saas_remediation.sql`, numbered at merge).**
- Delete only (ChatGPT Enterprise, Claude Enterprise; no vendor documents a quarantine). Off twice: the org switch and a
  separate delete-capable key per connector.
- Request (step-up), then approval in the existing queue by an admin other than the requester with a fresh
  `approval_decide` step-up, then one execution by the requester through the ADR-0124 kill switch. A timeout is
  `unknown` and is settled by a read.
- The lifecycle is declared on lane E29's `defineMachine` (ADR-0348); the slice 1 run lifecycle moved onto it too.
  Seven routes, API only (#453).
