# ADR-0040: ABAC / policy-as-code layered on the default-deny kernel (Cedar over OPA)

- **Status**: Proposed
- **Date**: 2026-08-01

## Context

RegulAIt's enforcement heart is `packages/policy-kernel` — a pure, zero-I/O evaluator the gateway
calls on **every** governed action (`evaluate` for MCP tools, `evaluateAgent`, `evaluateConnector`,
plus `visibleTools`). It is default-deny, its rules run in a fixed order, the first terminal match
wins, and it records a full `ruleChain` for the audit log. Entitlement composes as ADR-0013/0014
additive UNION-MAX with ADR-0019 per-user revocations as the only subtractive override. This RBAC
+ per-user-grant model is precise and battle-tested in the codebase, and it is the **single
enforcement point** the whole product depends on.

But some policies the enterprise/compliance surface needs are **not** expressible as static
per-user/per-role grants. They are conditional on **attributes** of the request:
- *"No write-capable MCP tool call against a HIPAA-classified project between 22:00–06:00."*
- *"Connector writes in the `production` environment require approval; the same call in `sandbox`
  does not."*
- *"An agent running in `air_gapped` deploy mode may not use any connector tagged
  `external_egress`."*
The kernel already gestures at this — `deployContext`/`RuleDeployMode` (ADR-0027 A4),
data-scope rules, the compliance cascade's `piiMode`/data-sensitivity (GOVERNANCE_LAYER_SPEC §8.3)
— but each is a bespoke, hardcoded dimension. Adding every future conditional dimension as another
hand-coded branch in the kernel does not scale and turns the audited core into a sprawl. We need a
general **attribute-based access control (ABAC)** / **policy-as-code** layer for conditional
policy, *without* discarding the RBAC model that works and *without* creating a second enforcement
point the audit trail can't see.

## Decision

Add an ABAC / policy-as-code layer that evaluates attribute-conditional policies **on top of** the
existing kernel, keeping the kernel as the single enforcement point and RBAC as the base grant
model. The ABAC layer can only ever **further restrict** (deny, or require approval) a call the
RBAC layer already allowed — it can never mint an allow.

**Engine choice: Cedar over OPA/Rego.** Both are credible; we weigh them explicitly.
- **OPA/Rego** is the incumbent general policy engine — powerful, ubiquitous, JSON-in/JSON-out,
  huge ecosystem. But Rego is a full logic language with a real learning curve, general Rego is
  *not* guaranteed decidable/terminating, and it is typically run as a **sidecar service** (a
  network hop and a second process to operate, patch, and secure — friction against our BYOC/
  air-gapped and zero-extra-infra goals).
- **Cedar** (the authorization language behind AWS Verified Permissions, Apache-2.0, Rust core
  with bindings) is purpose-built for authorization specifically: its policies are **analyzable and
  guaranteed-terminating** by design, it has a first-class **policy validation** step against a
  schema, and — decisively for us — it embeds **in-process** as a library, matching how
  `policy-kernel` is already a pure in-process module with no I/O and no sidecar. Cedar's
  permit/forbid model with `when`/`unless` conditions maps cleanly onto "RBAC grants the base, ABAC
  `forbid`s conditionally," and **`forbid` always wins** in Cedar — which is exactly our invariant
  (ABAC can only subtract).
We choose **Cedar**. The analyzability (needed for the ADR-0059 simulation work below), the
in-process fit (needed for air-gapped with no network dependency), and the forbid-wins default
outweigh Rego's broader generality — we are doing authorization, which is precisely Cedar's scope.
The engine is kept behind a thin internal interface so a future swap is a contained change, not a
rewrite of every policy call site.

**Layering — the kernel stays the single enforcement point.** ABAC does **not** run as a separate
gate the gateway calls in addition to the kernel. Instead, the kernel's evaluation gains an ABAC
step, evaluated **only on the allow path**, positioned like the existing revocation/lead-ceiling
checks: after a grant is found (so it can never rescue an ungranted call — that is default-denied
first and ABAC never sees it), composing with data-scope → rate-limit → approval. Concretely, the
kernel gains an optional `abacDecision` input (or an injected evaluator the gateway supplies the
attribute context to), and:
- ABAC `forbid` → the call is **denied**, with the matched policy id in `ruleId` and a new
  `abac-forbid` entry in the `ruleChain`.
- ABAC "require approval" → the call becomes `require_approval`, routed through the **same**
  ADR-0027/§3 Approvals Queue, not a parallel one.
- ABAC silent / no matching forbid → the call proceeds through the remaining kernel checks exactly
  as today.
Because it lives inside the one evaluator, every ABAC decision is in the **same `ruleChain` and the
same audit log** as every RBAC decision — there is provably no second, unaudited enforcement point.
RBAC remains the base: **ABAC never grants.** A call must be RBAC-allowed *and* survive ABAC. This
is stated as an invariant and must be locked by a kernel test, exactly as the additive-only /
allow-path-only invariants for revocations already are.

**Attributes — user / resource / context.** Policies are written against three attribute bags the
gateway assembles from data it already holds and passes into the evaluator (the kernel stays pure —
attributes are *inputs*, never looked up inside the kernel):
- **User/principal**: user id, assigned roles (incl. group-derived, ADR-0038), team(s),
  `isAdmin`, session `origin` (ADR-0028), authentication strength (MFA-completed?).
- **Resource**: the agent/connector/MCP-server-tool being called, its `kind` (read/write), its
  price tier, and the **project/Initiative** the work is attributed to (`x-regulait-project-id`)
  together with that project's **compliance classification and data-sensitivity** (the §8.3
  cascade's tags — this is the attribute regulated policies most need).
- **Context**: `environment` (sandbox/production — the attribution surface already distinguishes
  these), **deploy mode** (`hosted | byoc | air_gapped`, the server-derived `deployContext` A4
  already computes), **time-of-day** (evaluated against a policy-declared timezone, not the
  server's incidental locale), and request-rate/budget signals already available at the call site.
The attribute schema is a Cedar schema, versioned with the policies, so a policy referencing an
undefined attribute is a **validation error at write time**, not a silent no-match at runtime.

**Policies are versioned, testable, and simulatable.**
- **Versioned**: policies are stored as policy-as-code (a `abac_policies` table holding the Cedar
  source + schema version + author + timestamp, and — honoring the pillar-1 "governance is
  version-controlled, code-reviewed, deployed like infra" principle, §5 — exportable to a
  customer's own repo). Every activation is an audited, revertible version bump; the active
  policy set is a specific version, and rollback is selecting a prior version, never an in-place
  edit that loses history.
- **Testable**: because Cedar is a pure decision over an explicit request context, policies ship
  with **unit tests** (request context + expected permit/forbid) run in CI, the same way the kernel
  invariants are locked today. A policy change that flips an existing test is caught before it
  ships.
- **Simulatable**: the "what could user X do right now" access-preview (§5) extends to ABAC —
  simulate a hypothetical request context (this user, this tool, this project-classification, this
  time/environment) and get the full decision + `ruleChain` **without executing**. This ADR
  establishes the *hook*; the full policy-simulation surface (dry-running a proposed policy version
  against recorded historical requests to see what would newly deny before activation) is
  specified in the future **ADR-0059 (policy-simulation)** and is cross-referenced here as the
  intended consumer of Cedar's analyzability.

**Default posture: no ABAC policies = today's behavior, exactly.** With an empty policy set the
ABAC step matches nothing, forbids nothing, and every evaluation is byte-identical to the current
kernel — the same "absent input = unchanged behavior" discipline every prior kernel extension
(role grants, revocations, deploy-mode) already follows. ABAC is opt-in per deployment.

## Consequences

- **Easier**: attribute-conditional policy (time-of-day, environment, data-sensitivity, deploy
  mode) becomes expressible **declaratively** without hand-coding each dimension into the kernel;
  the compliance cascade (§8.3) gains a real enforcement language for "what a classification
  *requires*" beyond the current fixed knobs; governance becomes genuinely policy-as-code —
  versioned, tested, reviewed, exported.
- **Invariants preserved**: one enforcement point (ABAC lives *inside* the kernel evaluation, not
  beside it), one audit trail (same `ruleChain`/audit log), one Approvals Queue, and RBAC-as-base
  (ABAC can only subtract — never grants, never rescues an ungranted call). Empty-policy behavior is
  identical to today.
- **Deliberately given up / out of scope**: replacing RBAC (explicitly *not* doing this — the
  UNION-MAX grant model stays the base and reason about "who can do what" still starts there);
  ABAC-as-a-grant (there is no `permit` that widens entitlement — Cedar `permit` here only means
  "does not forbid"); and OPA/Rego's fuller generality (we accept Cedar's narrower,
  authorization-only scope as the right trade for analyzability + in-process fit). Rego remains the
  fallback if Cedar's expressiveness proves insufficient for a real policy — the thin engine
  interface is what keeps that swap contained.
- **Honest risks**: (1) **two policy languages to reason about** — RBAC grants and Cedar forbids —
  raises the cognitive load of "why was this denied"; mitigated because *both* land in one
  `ruleChain`, but admins now must read policy in two idioms, and the UI must make "denied by an
  ABAC policy" as legible as "default-deny"; (2) time-of-day and environment attributes are only as
  trustworthy as their source — time must be evaluated against a **declared** timezone (not the
  server's, and never a client-asserted clock), and `environment`/`deployMode` stay
  **server-derived** exactly as A4 already insists, or a client could dodge a policy by lying about
  context; (3) Cedar is a newer dependency in a security-critical path — its CVE exposure rides
  ADR-0017's automated patching and the in-process (no sidecar) footprint keeps the attack surface
  smaller than an OPA service would; (4) policy authoring is powerful enough to lock the org out of
  its own tools — the simulation hook (and ADR-0059's full dry-run-before-activate) is the required
  mitigation, so activating a forbid without previewing its blast radius should be friction, not a
  one-click default.
- **Follow-up work**: the thin Cedar engine wrapper behind an internal interface; the kernel's
  `abac`-step integration + the `abac-forbid` `RuleName`/trace + the RBAC-base/allow-path-only
  invariant test; migration for `abac_policies` (source + schema version + audit); the attribute
  assembly at the gateway call sites (reusing project-classification, environment, deploy-context,
  session-origin already available); CI policy-unit-test harness; export-to-repo of the policy set;
  extending access-preview to ABAC; and **ADR-0059 (policy-simulation)** for dry-running a proposed
  policy version against historical requests before activation.
