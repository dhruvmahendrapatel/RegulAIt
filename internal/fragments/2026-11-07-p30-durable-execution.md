<!-- fold: pending -->
**P30 — Durable execution for pillar 2's stages (SDK and platform review, owner, 2026-11-07).** The stage runner is
request-driven: there is no fan-out inside a stage and no automatic retry with backoff. **Spiked 2026-11-07
([ADR-0254](../decisions/0254-workflow-durable-execution-spike.md)): `vercel/workflow` with `@workflow/world-postgres`
does not fit.** It hard-codes its schemas with no RLS, costs about 18× more per step, churns fast, uses an
unauthenticated delivery route, cannot audit in the event's transaction, and pins vulnerable dependencies. trigger.dev
is rejected too. What it would take: keep the existing runner and add in-stage fan-out for named checks, plus retry
with backoff over graphile-worker (MIT) or pg-boss (MIT). Keep the audit row in the transition's transaction, and
borrow wait-for-token, idempotency keys and per-queue concurrency limits. Each part gets its own ADR. The prototype is
in `spikes/workflow-p30/`.
