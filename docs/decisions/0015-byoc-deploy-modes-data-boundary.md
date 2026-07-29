# ADR-0015 — BYOC deploy targets: three deployment modes + a control-plane data boundary

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** user (in-session), Claude
- **Supersedes / relates:** pillar 3 (§8 of GOVERNANCE_LAYER_SPEC); builds on the pillar-2
  deploy → verify → rollback tail (ADR-none; session-02 addendum 29).

## Context

Pillar 3 promises three deployment modes — **hosted** (we run it), **BYOC** (the customer's own
cloud account under their own IAM), and **air-gapped** (customer-hosted, disclosed data boundary).
The workflow engine's `deployment`/`rollback` stages already run through a provider-agnostic deploy
adapter, but every target was effectively "hosted mock". We needed (a) a real BYOC adapter shape and
(b) a concrete, enforced meaning for the disclosed **control-plane / agent-execution-plane data
boundary** — not just prose.

## Decision

1. **A deploy target carries a `mode`** (`hosted` | `byoc` | `air_gapped`, default `hosted`) plus,
   for AWS BYOC, a `roleArn` + `region`. Mode and role live on the `deploy_targets` row
   (migration 0033); the credential (when any) stays encrypted at rest, the roleArn is a
   non-secret identifier and is returned in views.

2. **BYOC AWS deploys via STS AssumeRole, never a static key.** The `AwsDeployProvider` models
   the real flow — assume the customer's `roleArn` for short-lived credentials, then deploy in
   their `region` — the same no-long-lived-keys rule as our own infra (ADR-0002/0004). In this
   slice execution is a **dry-run** (deterministic, no network, no cloud resource created — nothing
   deploys to a real account without the user's explicit in-session sign-off, per the standing
   guardrail); the two `// REAL:` markers in the adapter are exactly where the `@aws-sdk` calls go.

3. **The data boundary is enforced in the deploy/rollback executor, by mode.** In
   **air-gapped** mode the control plane retains **metadata only** for a deploy/rollback — the id,
   target, environment, and mode — and never the deploy URL or the provider's detail string, which
   could carry execution-plane specifics. `hosted`/`byoc` keep the full record. This makes the
   disclosed boundary a testable property (the air-gapped e2e asserts no URL/detail crosses back),
   not a promise.

## Consequences

- **Positive:** a BYOC target is a first-class governed resource; the boundary is code-enforced and
  falsifiable; the adapter shape is ready for real `@aws-sdk` wiring behind an explicit go-ahead;
  provider-agnostic by construction (azure/gcp/kubernetes are declared, not integrated — naming one
  is an honest failure → manual handoff, never a pretend success).
- **Negative / deferred:** execution is dry-run until a customer points a target at a live account
  (needs the `@aws-sdk` dependency + assume-role wiring + explicit sign-off); azure/gcp/kubernetes
  adapters; per-mode policy beyond the data boundary (e.g. air-gapped forbidding certain connector
  scopes) is future work; the audit log already records deploy events but a mode-aware retention
  policy is not yet wired.
- **Guardrail restated:** no `prod`/production designation and no deploy to a real account without
  the user's direct, explicit in-session sign-off.
