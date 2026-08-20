# RegulAIt vs the AI-governance (GRC) tier
*Credo AI · Holistic AI · IBM watsonx.governance · Microsoft Purview/Agent 365 · ServiceNow AI
Control Tower — profiles and dates in [MARKET_ANALYSIS_2026-08.md](MARKET_ANALYSIS_2026-08.md);
the Credo deep-dive in [GAP_ANALYSIS_CREDO_AI_2026-08.md](GAP_ANALYSIS_CREDO_AI_2026-08.md).
Every RegulAIt cell links the ADR that makes it true. Their cells are search-index/vendor-doc
sourced, dated 2026-08-15.*

**The one-line difference:** they govern *records of* AI; RegulAIt is the plane AI *runs
through*. When a control matters, ask each vendor the same question — *"show me the call your
control stopped."* Ours is an audit row with a rule id; theirs is a trace reviewed later or a
questionnaire answered earlier.

| Capability | GRC tier (typical best) | RegulAIt |
|---|---|---|
| Where enforcement happens | Post-hoc trace evaluation (Credo, 2026); identity-plane conditional access (Agent 365); agent kill-switch (ServiceNow/Traceloop) | **Pre-call, inline, per action**: default-deny on every model/tool/connector call, per-user grants, per-mode, per-object scope (pillars 1/7; ADR-0078 conformance table) |
| Regulation → runtime | Policy packs map to *attestations and evidence requests* | Packs map to **enforced controls**: a compliance tag cascades into required stages, PII mode, retention (§8.3, ADR-0058, demo-seeded ADR-0077) |
| Evidence | Questionnaires, uploaded artifacts, vendor portals | **Evidence is a query** over ledgers the enforcement itself writes; seed it → green, delete it → red (ADR-0058) |
| Audit integrity | Database-backed audit trails | Hash-chained log **anchored to WORM storage; tamper resistance observed from the medium at runtime**, never claimed from config (ADR-0060) |
| Cost | Absent across the tier | Per-project attribution at every call, budgets → approvals queue, metered+imported kept apart, reconciliation (ADR-0069/0076) |
| SDLC | Ticket-shaped workflow at best (ServiceNow) | PR-shaped: plan-only gate (ADR-0079) → sign-off → build → checks → merge gate → governed deploy/rollback (pillar 2) |
| Deployment | Governance SaaS; enterprise platforms | **BYOC and air-gapped first**, signed offline updates, offline license (ADR-0041/0062/0052) |
| Where THEY are ahead — honestly | Use-case intake front-doors, curated risk/control libraries, vendor-risk portals, discovery, board reporting, certifications, governance copilots | In flight (L1/L2/L7/L8 per the gap analysis) or deliberately deferred (discovery, vendor portal) or blocked on a live model credential (copilot); **no certifications held** — stated, not hidden |
