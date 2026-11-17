<!-- fold: state-recap -->
**2026-11-17 - lane E37 PR 3: Atlassian Rovo-agent and MCP audit events as evidence ([ADR-0356](../decisions/0356-pm-assigned-work-triggers.md) §3, migration `pending/pm_audit_events.sql`, numbered at merge).**
An admin attaches a read-only Atlassian organisation audit feed to a Jira connection (off by default; enabling and the
key are step-ups). The poll (on demand, and the hourly `pm-audit-ingest-sweep`) reads the events-stream through the
egress guard and stores matching Rovo/MCP events once each as append-only third-party evidence, one audit row per
page, without IPs, geolocation or names. It decides nothing and writes nothing to Atlassian. Follow-up: a retention
sweep for this evidence. Lane E37's three PRs are built.
