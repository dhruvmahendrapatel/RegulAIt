<!-- fold: state-decisions -->
**ADR-0214 amendment (builder, 2026-11-07): one explainable score per asset (PENDING P3 follow-up).** Agents and use
cases are scored, over the ADR-0214 objectives that apply to each (agent: risk, adversarial, access, evaluation, divisor
60; use case: risk, access, divisor 35), with the published weights and the shared `combineObjectives()`. Coverage,
audit and spend are listed as not applicable; model cards, MCP servers and connectors are not scored (no ledger row
names them). `GET /v1/reports/posture/assets` (keyset, at most 100) and `/:kind/:assetId`, scoped to assets the caller
can already read (admin all; steward's agents; owned use cases), `private, no-store`, no server cache. No migration.
API only; the per-asset UI is requested on #453.
