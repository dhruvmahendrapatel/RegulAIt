<!-- fold: pending -->
**G3 — cost per outcome and budget alerts: built 2026-11-15 ([ADR-0312](../decisions/0312-cost-per-outcome.md)).**
Open:
- the dashboard cards for the seven `/v1/cost-outcomes` and spend-budget routes (#453);
- attributing spend made outside an orchestration run (workflow review-check agents) once those calls carry the
  instance id;
- owner question: should a person's budget also alert on imported spend (today metered only, with imported shown beside
  it)?

G9 (paid-call budgets) is paused until after the pilot (owner, 2026-11-15). It is built on
`builder/e2-paid-call-budgets`, unmerged.
