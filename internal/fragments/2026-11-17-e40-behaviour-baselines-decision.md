<!-- fold: state-decisions -->
**ADR-0359 (builder lane E40, 2026-11-17, Proposed; owner decision 2026-11-17, competitor gap audit Obsidian row 9 and DarkControl row 20): learned behaviour baselines.**
- **What (slice 1):** a sweep (`behaviour-baseline-sweep`, every 60 s) rolls the install's own audit chain up into
  per-day counts per user and per agent (workload identity), and compares each complete UTC day with the 28 days
  before it: model-call and data-scoped-call volume by robust z-score (Iglewicz–Hoaglin, MAD; 3x-median fallback when
  flat), and tools, destinations and hour of day by share of history (below 2% fires). Statistics from
  `simple-statistics` (ISC, already pinned); no network, no model, no cross-customer pool, air-gapped.
- **Shadow mode** is the default and the only mode built: findings only, never enforcement. Each finding stores its
  baseline and deviation and writes one chained audit row (SIEM export through ADR-0303). Turning it off is a
  `settings_relax` step-up. Finding status is a declared table (open → acknowledged | dismissed → terminal).
- Migration `pending/behaviour_baselines.sql`. API only: six routes are known UI gaps on #453. Slice 2 (rule
  suggestions in lane E15's pack format, backtested, approved with step-up) follows.
