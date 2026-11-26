<!-- fold: state-recap -->
**2026-11-17 - lane E39 slice 2: CMDB sync, ServiceNow first ([ADR-0358](../decisions/0358-ai-adoption-analytics-and-cmdb-sync.md), migration `pending/cmdb_sync.sql`, numbered at merge).**
The AI asset inventory (agents, MCP servers, models, endpoints by pseudonym) is pushed to ServiceNow as configuration
items through the IRE API, behind a vendor-neutral `CmdbAdapter`. Each item carries a stable source key, and a
per-item ledger skips unchanged assets. Connectors start disabled and export only. The credential is encrypted under
the data key and rotatable; enabling it and turning on the ownership read-back each need a step-up and a reason.
Traffic goes through the guarded fetch only, the feature is refused when air-gapped, and every run and change is
audited. The ownership read-back is recorded, never applied. API-only; the screen is on #453.
