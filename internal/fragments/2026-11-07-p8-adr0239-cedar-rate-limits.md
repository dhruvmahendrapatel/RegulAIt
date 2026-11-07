<!-- fold: state-decisions -->
**ADR-0239 (builder, 2026-11-07): one policy language, slice 1 (PENDING P8).** The nine hand-written kernel evaluators
are inventoried with a Cedar fit for each. Rate limits move onto Cedar first (`policy-kernel/src/rate-limit-cedar.ts`):
one `forbid` per limit, entity by position, no stored value in policy text, preparsed per size. The kernel stays
dependency-free: `EvaluationInput.rateLimitEvaluator` is injected (default `legacyRateLimitEvaluator`), and the gateway
passes Cedar. Errors deny (`rate-limit-engine-error`). `REGULAIT_RATE_LIMIT_EVALUATOR=legacy` is kept for one release,
logged at boot, and any other value refuses boot. A fast-check differential test shows the two agree. Cost is
0.23–1.4 ms for 1–20 limits (ABAC is 1.3 ms). Next: approval-rule match (slice 2), batched into one Cedar call. No
Zanzibar store: membership is flat, so Cedar entity parents suffice; OpenFGA if it becomes recursive. No migration.
