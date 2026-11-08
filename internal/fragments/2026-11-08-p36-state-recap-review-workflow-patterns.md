<!-- fold: state-recap -->
**2026-11-08 - P36 built (builder lane): review workflow patterns ([ADR-0260](../decisions/0260-review-workflow-patterns.md), builder, branch `builder/p36-review-workflow-patterns`).**
- **Our process:** reviewers follow `internal/process/REVIEW_CHECKLISTS.md` (two loops; numbered findings with a
  severity; READY lists each finding with its fixing commit; verdicts start `APPROVE at <sha>` / `SECURITY APPROVE at
  <sha>`; post without asking; delta reviews cover non-merge commits since the last verdict); the `regulait-review`
  skill loads it. Adapted from OneRedOak/claude-code-workflows (MIT, credited in apps/gateway/THIRD_PARTY.md).
- **Product:** a review-bound check (`reviews` on an `automated_check` stage: code, OWASP Top 10 security, design/UI)
  runs as a governed dispatch as the instance initiator and returns numbered structured findings; any finding above a
  nit fails by default; four gallery shapes, off unless assigned. No migration.
- **Open (PENDING §2i P36):** a PR diff read on the git providers, a governed Playwright step for the design review,
  and the UI (posted to #453).
