<!-- fold: state-recap -->

**2026-11-17 - E27 slice 2: the fairlearn engine and signed, cross-checked fairness runs ([ADR-0346](../decisions/0346-fairness-evaluation-through-the-gateway.md)).**
A new `eval` sidecar engine, `fairlearn` (fairlearn 0.15.0, hash-pinned closure, licence gate, offline proof; off
until its first signed publish), runs a model card's model through the gateway on a model-input dataset. The gateway
builds the task's input from its encrypted dataset (the runner never sees rows), re-measures the task's predictions
with `computeFairness` and records the run only when fairlearn agrees; anything else is inconclusive and holds the
card. Every fairness run, supplied or model, is signed evidence cited on its card, and a card holding it cannot be
deleted. Pending migrations `fairlearn_engine` and `fairness_evaluation_engine_input`.
