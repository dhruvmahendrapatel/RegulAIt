<!-- fold: state-recap -->

**2026-11-15 - G1: opt-in, per-tenant read-only vendor usage/cost pull ([ADR-0322](../decisions/0322-opt-in-vendor-usage-cost-pull.md), builder lane E7).**
Owner decision: a tenant admin may add a read-only vendor usage/cost credential; off by default; file import stays.
ADR-0322 amends ADR-0069 and ADR-0076. Pulled lines are `basis = 'imported'`, never blended with metered spend; lines
billed to a key the gateway itself holds are marked `overlaps_metered` and excluded, with the exclusion disclosed.
Air-gapped installs keep file import only. Connectors (Anthropic, OpenAI, Copilot, Cursor, Codex, AWS CUR 2.0) follow
in three slices. This slice is documentation only.
