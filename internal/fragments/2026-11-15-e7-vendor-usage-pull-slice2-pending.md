<!-- fold: pending -->
- **ADR-0322 vendor usage pull — slice 2 built (lane E7).** Left: GitHub Copilot and Cursor connectors (slice 3); AWS
  CUR 2.0 Bedrock spend and OpenAI Codex analytics (slice 4); Google Vertex/Gemini billing export if time allows;
  Claude Code per-user attribution (needs an attribution-only design: its API-billed cost is already in the cost
  report); moving Anthropic to the Analytics API once it leaves beta; the settings screen (#453); live-tenant tests with
  the owner's test keys (lane E11). From the #861 review: row-level security on
  `imported_cost_lines` and `cost_import_batches` (the ADR-0069 import surface; the four vendor-usage tables are under
  RLS already); a per-vendor rate limit with in-run backoff on 429 (today a 429 fails the run and the next pass resumes
  from `pulled_through`); the §5 vendor-against-metered variance report.
