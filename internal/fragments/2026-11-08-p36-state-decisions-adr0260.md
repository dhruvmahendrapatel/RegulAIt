<!-- fold: state-decisions -->
**ADR-0260 (builder, 2026-11-07, Accepted): review patterns from OneRedOak/claude-code-workflows (backlog P36).**
- **Process:** `internal/process/REVIEW_CHECKLISTS.md` and `.claude/skills/regulait-review/SKILL.md`; the security review
  keeps rate limiting, audit logging and hardening in scope (the source excludes them).
- **Product:** `reviews: [{check, agent, profile, failOn?, maxTokens?}]` on an `automated_check` stage, a third
  machine-decided check kind beside evals (ADR-0044) and engines (ADR-0187); the shared eval decider, the `evals`
  model feature, project cost, the dispatch audit; evidence in a delimited untrusted block; zod-validated findings
  numbered F1…; fails closed; cannot be reported; unknown reviewer refused at template creation; `reviewerAgent`
  required when creating a review gallery shape. Gallery: `code-review-check`, `security-review-check`,
  `design-review-check`, `build-and-review`. No migration.
