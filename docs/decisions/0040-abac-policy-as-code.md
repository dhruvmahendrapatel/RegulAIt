# ADR-0040: ABAC / policy-as-code layered on the default-deny kernel (Cedar over OPA)

- **Status**: Accepted
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

---

## Implementation amendment — 2026-08-02 (migration 0054)

**Status: Accepted.** Implemented as decided: Cedar, in-process, evaluated **inside** the policy
kernel on the **allow path only**, restricting-only, versioned, testable, simulatable. This section
records what shipped, the shapes chosen where the ADR left them open, and the deviations — stated
plainly rather than buried.

### 1. The engine, as it actually embeds

`@cedar-policy/cedar-wasm@4.12.0` (Apache-2.0, the Rust Cedar core compiled to WebAssembly),
imported from its `/nodejs` entry point. It loads and evaluates **synchronously in-process**: no
sidecar, no network hop, nothing to run in an air-gapped deployment beyond the gateway itself —
which was the decisive argument over an OPA service and is now a fact rather than a plan.

It lives behind a thin internal interface (`AbacEngine`: `validate(source, schemaVersion)` →
errors, `evaluate(policies, request)` → verdict) in **`packages/policy-kernel/src/abac.ts`**, which
is the only module in the repository that imports Cedar. Swapping to Rego means implementing that
interface again; nothing else moves. `packages/policy-kernel/src/index.ts` — the pure evaluator —
does **not** import it, so `import "@regulait/policy-kernel"` never loads the wasm module.

### 2. Where ABAC sits in the kernel, exactly

`EvaluationInput` gains an optional `abacDecision` (a verdict the gateway computed, never a policy
the kernel parses). Its position in the fixed rule order:

```
grant check (allow-list → role → read-all → role read-all)   ← ungranted = default-deny, ABAC never runs
lead-ceiling                                                  (ADR-0027 §5.1)
ABAC forbid            ← NEW: terminal, like the lead ceiling
data-scope
rate-limit
ABAC require_approval  ← NEW: folded into the ONE approval step
approval-required                                             (the pre-existing rules)
allow
```

A `forbid` is terminal for the same reason the lead ceiling is: a call an attribute policy refuses
is refused regardless of data scope, rate limits or approvals. A `require_approval` is deliberately
**not** terminal at that point — it is evaluated at the approval step, so a data-scope or
rate-limit **deny still wins over an ABAC pause** (a pause must never become an escape hatch), and
an already-approved queue entry satisfies it through the same `approvedApprovalId` mechanism a
rule-driven approval uses. When both an ABAC pause and an approval *rule* match, the ABAC policy
governs (it is the more specific, conditional statement); with no ABAC input the approval path is
byte-identical to before.

`RuleName` gains **`abac-forbid`**, which carries `outcome: "deny" | "require-approval" |
"satisfied-by-approval"`. `ruleId` on a forbid/pause is the **policy id**, so
`approvals.rule_id` — the same uuid column an approval rule fills — points at the policy, and one
audit query still answers "why was this denied".

**Fail-closed detail the ADR did not specify:** a `require_approval` verdict that names no approver
degrades to a **deny**, not to an allow. There is nobody to route the queue entry to, and an
enforcement layer that opens when it is misconfigured is worse than none. (The write-time
validation and a DB CHECK both make that state unreachable through the API; the kernel refuses it
anyway.)

### 3. The versioning shape

Two tables, because a single table would have to be UPDATEd in place and that destroys the thing a
governance surface exists to preserve:

- **`abac_policies`** — the stable **identity**: `name` (unique), `description`, `enabled`, and
  `active_version_id`, a pointer at whichever version is live. Its `id` is what lands in `ruleId`,
  in the `abac-forbid` trace and in `approvals.rule_id`, so it survives every edit.
- **`abac_policy_versions`** — **immutable** rows: `version` (unique per policy), `source`,
  `schema_version`, `mode`, `timezone`, `approver_user_id`, `test_cases`, `author_user_id`,
  `created_at`.

Editing a policy **INSERTs** version max+1 and changes nothing until it is activated. Activation is
a single audited UPDATE of the pointer. **Rollback is that same operation aimed at an older row** —
there is deliberately no separate rollback verb, and the version rolled away from still exists and
is still re-activatable, so a rollback is itself revertible. `mode` is CHECK-constrained to
`('forbid','require_approval')`: there is no column in this schema that can widen entitlement.

A newly created policy is **`enabled = false`**. Authoring is safe; activating is the governed act.
That is the ADR's "activating a forbid without previewing its blast radius should be friction, not
a one-click default", made structural.

### 4. Attributes, and what "server-derived" means here

Assembled at the gateway (`apps/gateway/src/abac.ts`), never inside the kernel — which is what lets
the simulation surface reproduce an enforcement decision exactly.

- **principal**: user id, role **names and ids** (including ADR-0038 group-derived ones), team
  names, `isAdmin`, `sessionOrigin` (the ADR-0028 origin recorded on the session row), and
  `mfaCompleted`.
- **resource**: `serverId`/`serverName`/`toolName`, `kind` (read/write), `priceTier`
  (`unpriced|free|metered` — a tier, not a figure), the attributed `projectId`/`projectName`, and
  that project's `classifications` (the §8.3 cascade tags) plus a scalar `dataSensitivity`.
  `projectId`, `projectName` and `dataSensitivity` are declared **optional** in the Cedar schema, so
  strict validation forces a policy to guard them with `has` rather than let an unattributed call
  read as a match.
- **context**: `deployModes` and `environments` (both **sets**, derived exactly as ADR-0027's A4
  deploy context is — the attributed project's in-flight workflow instances → their deploy targets),
  `hour`/`minute`/`dayOfWeek` computed **in the policy's declared timezone**, the `timezone` itself,
  and `rateLimitUsagePct` (the rate signal already computed at the call site).

`mfaCompleted` is derived as "a cookie session belonging to an account with TOTP active" — which,
given the two-step login gate, is precisely the set of sessions that presented a second factor.
Header API-key and bootstrap requests report `false` and origin `api_key`/`bootstrap`. The
derivation lives in its own file (`abac-principal.ts`) with no access to `req.headers`, so "could a
client fake this?" is answerable by reading one function.

**Time.** Policies are grouped by declared IANA zone and each group is evaluated against
hour/minute/day computed in *that* zone. A zone this runtime cannot resolve is refused at write
time; at evaluation an unresolvable zone falls back to **UTC**, never to the host's locale. The
gateway test file sets `process.env.TZ = "Asia/Tokyo"` for exactly this reason: every time-of-day
assertion in it would still pass against a server-clock implementation if the server clock agreed
with the policy, so it is forced to disagree.

### 5. Write-time validation

Cedar **strict** validation against the versioned schema runs before anything is stored, and the
API refuses on failure. In addition to the attribute check the ADR asked for, the validator refuses:
a Cedar **`permit`** (ABAC can never grant, and storing an inert `permit` would mislead an admin
into thinking they had widened access); an action the schema does not declare; a policy **template**;
and **more than one statement** in one stored policy (the row's uuid is the Cedar policy id, so
"which policy denied this" must be unambiguous).

The schema is **code**, versioned by the `schema_version` string on each policy version, because the
attributes a policy may reference are exactly the attributes the gateway assembles and the two must
move together. `GET /v1/abac/schema` publishes it as readable Cedar for the editor.

### 6. What shipped

- **Migration 0054** (`0054_abac_policies`): the two tables above, the circular
  `active_version_id` FK (`ON DELETE SET NULL` — losing the pointer deactivates, never
  cascade-deletes), the mode + approver CHECKs, and the `enabled` index the hot path uses.
- **`packages/policy-kernel/src/abac.ts`** — the Cedar wrapper, the versioned schema (`v1`), the
  timezone arithmetic, and the "a Cedar deny with no satisfied forbid is a NO-MATCH, not a denial"
  distinction that keeps a `permit`-less policy set from refusing everything.
- **`packages/policy-kernel/src/index.ts`** — the `AbacDecision` input, the `abac-forbid`
  `RuleName`, and the two composition points above.
- **`apps/gateway/src/abac.ts`** — the policy-set load (one indexed query; zero further cost when
  nothing is active), attribute assembly, the policy test runner, and the admin surface:
  `GET /v1/abac/schema`, `POST /v1/abac/validate`, `GET|POST /v1/abac/policies`,
  `GET /v1/abac/policies/:id`, `POST /v1/abac/policies/:id/versions`,
  `POST /v1/abac/policies/:id/activate` (also the rollback), `.../deactivate`, `DELETE`,
  `POST /v1/abac/policies/:id/test`, `POST /v1/abac/test` (the CI entry point), and
  `POST /v1/abac/simulate`.
- **`apps/gateway/src/governed-evaluate.ts`** — the single MCP choke point, wired.
- **SPA**: an admin *ABAC policies* screen under Governance — source editor with write-time
  validation errors surfaced against it, the version list with per-version Activate (= rollback)
  and Run tests, and the attribute schema rendered on the page so an author is never guessing.
- **Audit**: `objectType: "abac_policy"` for admin acts, with `abac-policy-activated` and
  `abac-policy-rolled-back` distinguished and carrying `from`/`to` version numbers. Policy
  *decisions* audit as ordinary governed rows — one audit trail, as required.
- **Tests**: 36 new in `packages/policy-kernel` (93 → 129) and 20 in
  `apps/gateway/src/abac-policy.test.ts` (1171 → 1191), including the ADR's named invariants:
  ABAC cannot rescue a default-denied call *and leaves no trace on one*; an empty/deactivated
  policy set is byte-identical to the pre-ADR-0040 kernel on a representative allow **and** deny,
  `ruleChain` compared in full; forbid → deny with the policy id in `ruleId`; require_approval →
  a row in the **existing** `approvals` table decided by the **existing** endpoint; the 12:00-allow
  / 23:00-deny conditional policy with the declared timezone proved against a deliberately wrong
  process TZ; header- and body-supplied `environment`/`deployMode` failing to reach the context;
  an undefined attribute refused at write; and v2 → rollback-to-v1 restoring v1's decisions with
  v2's row intact.

### 7. Deviations from the ADR as written — stated, not buried

1. **One action, `McpToolCall`.** The ADR's resource bag names "the agent/connector/MCP-server-tool
   being called". Only the MCP tool path has a single gateway choke point (`governedEvaluate`) where
   the attribute context can be assembled once and enforced for **every** caller; `evaluateAgent`
   has six call sites and `evaluateConnector` one, and wiring them piecemeal would create the exact
   failure this ADR exists to prevent — a policy an admin believes is enforced that silently is not
   on some paths. So agent and connector actions are **absent from the Cedar schema**, not
   present-and-unwired: a policy naming them fails validation at write time. Adding them is a schema
   version bump plus wiring, and is tracked as follow-up.
2. **Budget signals are not in the context bag.** The ADR lists "request-rate/budget signals already
   available at the call site". Rate is (`rateLimitUsagePct`); project-budget consumption is *not*
   available at `governedEvaluate` without new queries, so it is deferred rather than faked.
3. **`environment` is a SET, not a scalar** (`context.environments`), because attributed work can be
   in flight toward targets in more than one environment at once — the same reason ADR-0027's A4
   deploy context is a set. Policies use `.contains("production")`.
4. **`dataSensitivity` is derived, not a new column.** It is the project's compliance
   classifications (the source ADR-0018's 6th assignment dimension already treats as authoritative),
   exposed as a set plus a scalar convenience. No new sensitivity taxonomy was invented.
5. **Export-to-repo of the policy set** (listed under follow-up work) is not implemented; the
   `source` column is the artifact and `GET /v1/abac/policies/:id` returns every version's text, so
   the export is a thin wrapper rather than a missing capability.
6. **Visibility (`visibleTools`) is unchanged.** ABAC affects execution decisions, not which tools a
   user is *offered*. Filtering the manifest by an attribute policy would need the request context
   at list time and is deliberately out of scope here.
