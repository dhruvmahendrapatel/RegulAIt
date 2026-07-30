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

---

## Addendum — 2026-07-30 (deploy-tail follow-through: A1/A2/A3; A4 deferred)

The original decision left the AWS adapter as a dry-run shape, azure/gcp/kubernetes declared-only,
and no admin CRUD UI. This addendum records the follow-through shipped in the deferrals cleanup, and
explicitly defers the one remaining item (A4) with its design.

- **A2 — azure/gcp/kubernetes adapter shapes shipped.** Each is a deterministic, offline **dry-run**
  provider mirroring `AwsDeployProvider`: seeded ids, config validation (a missing subscription/
  project/kubeconfig is a clear `DeployProviderError`), and `// REAL:` markers at every SDK call
  site (`@azure/arm-*` slot-swap / container-app revision; Google Cloud Deploy / Cloud Run;
  `@kubernetes/client-node` rollout). `resolveDeployProvider` now resolves all five kinds; naming an
  unwired future provider stays an honest failure → manual handoff. No network, no cloud mutation.

- **A1 — real `@aws-sdk` STS path behind an off-by-default flag.** `REGULAIT_DEPLOY_LIVE` (default
  OFF) gates the AWS adapter's real path. `AwsDeployProvider` takes an OPTIONAL injected STS/deploy
  client (injectable-client discipline). Flag OFF → today's dry-run, **byte-identical** (existing
  tests pass untouched). Flag ON → the `// REAL:` markers construct a genuine
  `@aws-sdk/client-sts` `AssumeRoleCommand` (correct `RoleArn`/`RoleSessionName`/`DurationSeconds`)
  and drive a deploy through the injected client — unit-tested against a **FAKE** injected client,
  **never the network, never a live mutation**. Flag ON with no injected client is an explicit
  error, so no live path ever runs unwired. `@aws-sdk/client-sts` added to `apps/gateway` deps. The
  standing guardrail is unchanged: no deploy to a real account without the user's explicit
  in-session sign-off.

- **A3 — admin deploy-target management UI.** A "Deploy Targets" tab under the NAV **Delivery**
  group: a create form (name, provider, mode hosted/byoc/air_gapped, environment, baseUrl,
  role/account, region, optional credential → `POST /v1/deploy/targets`), a list
  (`GET /v1/deploy/targets`) built with the shared `dataTable`/`field`/`idChip` helpers, and per-row
  delete (`DELETE /v1/deploy/targets/:name`). All endpoints already existed; admin-only,
  credentials AES-256-GCM at rest and never returned.

- **A4 — per-mode policy + mode-aware audit retention: DEFERRED (design recorded).** Not
  implemented in this slice, deliberately, because the substrate for it does not yet exist:
  - The `audit_log` table has **no mode dimension** — a deploy audit row records object/effect/
    rule/reason but not the deployment mode (hosted/byoc/air_gapped) it happened under, so a
    mode-aware retention or per-mode policy would have nothing to key on without a schema change.
  - Audit retention today is a **single global floor** (the longest `auditRetentionDays` across
    compliance profiles; §8.4/`/admin → Audit` prunes to it), not a per-record or per-mode policy.
  - **Recorded design for when A4 is picked up:** add a nullable `mode` (or a structured
    `deploy_context`) column to `audit_log` populated by the deploy/rollback executor; extend the
    compliance-profile shape with an optional per-mode retention override and per-mode connector/MCP
    scope restrictions (e.g. air-gapped forbidding certain data scopes); enforce the tightest of
    {global floor, framework floor, per-mode override} at prune time. This is a migration + policy
    change, out of scope for a UI/adapter cleanup, and is left for a dedicated slice.

---

## Addendum — 2026-07-30 (A4 re-assessed, still deferred — sharper reasoning)

A4 was re-examined fresh during the ADR-0019 governance batch, including the cheapest-looking
option (deriving a deploy mode at prune time instead of adding a column). It was deliberately NOT
implemented, and the original "needs a schema change" note is superseded by three concrete findings
recorded in [ADR-0019](0019-per-user-revocation-and-full-attribution.md) §5:

1. There is nothing to derive a mode FROM. The deploy executor writes the target's mode into the
   **workflow instance's `context`**, never into an audit row — and >99% of `audit_log` rows (tool
   calls, agent invokes, connector calls, approvals, membership changes) have no deployment mode at
   all. Mode-aware retention over such a table is a special case, not a policy.
2. The only safe cascade composition is a no-op. MIN would **shorten** retention and delete audit
   evidence earlier than a framework requires — never acceptable. MAX (longest-floor-wins) is safe
   but adds nothing over raising the existing global floor, which is what ships today.
3. A4's real value is per-mode **policy**, not retention — and that belongs in pillar 1's
   rule-scoping model (`scope: user | role | team | fleet` gaining a mode-derived scope), as its own
   slice with its own ADR.

A4 therefore remains open, with the requirements now stated precisely: a populated
mode/`deploy_context` dimension on `audit_log` (including an honest story for pre-existing rows that
have no mode to backfill), a **MAX-only** per-mode retention override so retention can never be
shortened, and mode-scoped restriction rules in the pillar-1 rule model.
