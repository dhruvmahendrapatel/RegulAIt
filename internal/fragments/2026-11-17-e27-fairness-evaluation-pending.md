<!-- fold: pending -->

**E27 / ADR-0346 — fairness evaluation, remaining slices.** (2) the `fairlearn` sidecar engine (image, hash-pinned
closure, licence gate, offline proof; off until its first signed publish), model-input dataset upload with the cascade
PII check, the gateway cross-check against `computeFairness`, signed `fairness_run_evidence` and the `fairness_run`
card-evidence kind (ADR-0189 format change), the ADR-0150 collector counting measured runs. (3) evaluation and
schedule APIs, breach approvals through the one queue, the promotion gate at sign-off, the card fairness view with
red-team `bias` results; routes as known UI gaps on #453. Owner question open: should a risk tier, not only a
compliance tag, force the promotion gate? Note for slice 2: a card whose runs carry signed evidence cannot be deleted
(RESTRICT); the card delete path must refuse it with a named 409.
