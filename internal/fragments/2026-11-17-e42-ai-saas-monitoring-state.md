<!-- fold: state-recap -->

**2026-11-17 - E42 slice 1: monitoring sanctioned AI SaaS through vendor compliance APIs ([ADR-0361](../decisions/0361-sanctioned-ai-saas-compliance-monitoring.md), migration `pending/ai_saas_monitoring.sql`, numbered at merge).**
- Forcepoint gap 1. An admin registers a read-only connector to a Microsoft 365 Copilot tenant (Graph
  `getAllEnterpriseInteractions`, `AiEnterpriseInteraction.Read.All`); a run records each interaction as append-only
  evidence, scans it in memory with the ADR-0042 guardrails and ADR-0140 PII detector, and writes counts-only findings
  plus an audit row per match. Text is not stored unless redacted capture is turned on (step-up).
- Off three ways (org policy, connector, egress allow-list), refused when air-gapped; a token with any write role is
  refused and never used again. Retention is the audit floor extended by the connector's compliance tags.
- Ten admin routes, API only (KNOWN_UI_GAPS on #453). Next: ChatGPT Enterprise and Claude Enterprise connectors
  (slice 2), optional remediation on lane E19's transition-table pattern (slice 3).
