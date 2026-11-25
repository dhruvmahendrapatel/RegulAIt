<!-- fold: pending -->

**E37 — work assigned from the PM tool (owner, 2026-11-17; MARKET_ANALYSIS_2026-11 G4).** PR 1 built
([ADR-0356](../decisions/0356-pm-assigned-work-triggers.md)): Jira and Azure Boards triggers start a governed workflow
as the linked, entitled person; denials are commented on the item. Open: write-back (PR 2), Rovo/MCP audit-event
ingest (PR 3), trigger signals for Linear, Asana, monday and the generic webhook (one extractor case each), and the
screens for the six API-only routes (#453). Owner questions open: whether triggering needs a dedicated grant rather
than the agent grant, and whether to auto-link people by a verified email.
