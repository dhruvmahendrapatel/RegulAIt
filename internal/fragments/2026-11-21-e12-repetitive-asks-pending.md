<!-- fold: pending -->

**E12 / ADR-0328 — repetitive ask → smaller model, remaining slices.**
- (2) A settings singleton, off by default, with step-up and audit, plus a background scan of captured `trace_spans`
  for one agent through `findRepetitiveAsks`. It stores clusters as span ids, fingerprints and counts only, never text.
  Each cluster gets a suggested cheaper entitled agent from `routeModel` and a projected monthly saving. A read-only
  admin route, with a route census entry and a KNOWN_UI_GAPS entry for UI-D.
- (3) The eval gate: a sample of the cluster becomes an eval dataset, and `runEvalSuite` must pass for the candidate.
  Then a shadow period.
- (4) The switch: a step-up request decided by a named administrator in the approvals queue. Serving narrows
  `routeModel`'s candidates to the approved agent for asks in the cluster, recorded as a `model_routing` cost event.
  One-action revert.
