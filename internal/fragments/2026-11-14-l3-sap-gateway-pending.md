<!-- fold: pending -->

**P19 follow-ups from Lane L3, first PR ([ADR-0230 amendment](../decisions/0230-sap-business-agents-over-mcp.md)).**
Open: identity release, subject-token
retention and confirm-by-fresh-step-up (need slice A0); the screen for the three `system-class` routes (#453); a create
and edit path for `rate_limits.write_only` in the rule API (today only the SAP seeding writes it); a tool-kind
dimension for the policy-replay counter, so a simulated write-only limit counts writes only (it over-counts today); cross-check an SAP `replayed: true` result against the stored key's claim before charging it 0 (code review #882). An admin-confirmed read allow-list per SAP business server (today every tool on a marked server is a write, review #798), and a registration-time prompt or a hint when a server's tools look like SAP business tools, so an SAP server is not left unmarked (security review #798). The screen for the four `sap*` org settings (owner decision 2026-11-15; API only today, #453).
