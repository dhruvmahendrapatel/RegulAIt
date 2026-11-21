<!-- fold: state-recap -->

**2026-11-17 - E27 slice 1: fairness evaluation through the governed gateway, ADR and schema ([ADR-0346](../decisions/0346-fairness-evaluation-through-the-gateway.md), builder lane E27; extends ADR-0222).**
RegulAIt will run a model card's model on a customer's model-input dataset through the gateway, in a new `fairlearn`
sidecar engine (fairlearn 0.15.0, MIT; AIF360 rejected for no release in 12 months), cross-check fairlearn's metrics
with ADR-0222's `computeFairness`, sign every run as evidence on the card and in the compliance packs, open an
approvals-queue item on a breach (time-boxed risk acceptance, at most 90 days) and, where an org opts in or a compliance
tag requires it, gate the card's sign-off on a fresh passing run. Slice 1 is the schema only: migration
`pending/fairness_evaluation.sql` (numbered at merge) and the pure module `packages/shared/src/fairness-evaluation.ts`.
Slices 2 (engine, metrics, evidence) and 3 (gate and APIs; UI via #453) follow.
