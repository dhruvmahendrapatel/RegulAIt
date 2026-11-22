<!-- fold: state-recap -->
**2026-11-17 - lane E39 slice 1: AI adoption analytics ([ADR-0358](../decisions/0358-ai-adoption-analytics-and-cmdb-sync.md), migration `pending/adoption_analytics_policy.sql`, numbered at merge).**
Six admin-only, paginated `/v1/adoption/*` routes read the existing ledgers at call time: metered active users per
tool (agent, connector, MCP server, A2A agent) per day/week/month and team or project, the top tools (metered and,
separately, imported vendors), and seat utilisation from applied, unsuperseded imported lines. Metered and imported
are never added. Privacy defaults: per-person ranking off (turning it on is a step-up relaxation with a reason, and
each read is audited) and counts of people below 5 suppressed. API-only; the screen is on #453. Slice 2 (CMDB sync,
ServiceNow first) follows.
