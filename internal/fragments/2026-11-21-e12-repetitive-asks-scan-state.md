<!-- fold: state-recap -->

**2026-11-21 - E12: repetitive-ask detection at the gateway ([ADR-0328](../decisions/0328-repetitive-ask-to-smaller-model.md) slice 2, builder lane E12).**
Detection is off by default, and turning it on or relaxing it needs a step-up.
- **Scan:** an admin-only scan of captured previews, run on a worker thread, stores clusters of near-duplicate prompts.
  It keeps fingerprints, counts, measured cost and up to 50 member span ids per cluster, never prompt text.
- **Suggestion:** for each cluster, the cheaper agent that right-sized routing (`routeModel`) would pick, with a
  projected monthly saving.
- **Lifecycle:** clusters can be dismissed, which is final.
- **Scope:** read-only. Nothing changes routing yet.

Next: the eval gate and shadow period (slice 3), then the approval switch, serving and revert (slice 4).
