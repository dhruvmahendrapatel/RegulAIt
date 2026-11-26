<!-- fold: pending -->

- **AI SaaS remediation follow-ups (ADR-0361 slice 3, lane E42).** (a) The remediation screen on #453 (seven API-only
  routes). (b) Register `ai_saas_monitor_run` and `ai_saas_remediation` in lane E29's `STATE_MACHINES` registry so
  `GET /v1/state-machines` lists them (E29 owns the registry). (c) Owner question: whether a conversation delete
  should stay blocked under a non-`normal` execution mode (built: blocked, through `runExternalWrite`) or be allowed
  as a narrowing action during an incident.
