# ADR-0239: One policy language: move hand-written evaluators onto Cedar, rate limits first; no Zanzibar store yet

- **Status**: Accepted for slice 1 (builder lane P8, 2026-11-07). Later slices are proposals, each needing its own PR.
- **Date**: 2026-11-07
- **Extends**: [ADR-0040](0040-abac-policy-as-code.md) (Cedar in process through `@cedar-policy/cedar-wasm`), ADR-0188
  S2 (v4 schema, fail closed on evaluation errors), [ADR-0011](0011-shared-projects-on-one-project-entity.md) (Shared
  Projects are one `projects` entity with `project_members`).
- **Migration**: none.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P8.

## Context

ABAC is evaluated by Cedar (`packages/policy-kernel/src/abac.ts`). Every other rule type in the kernel is hand-written
TypeScript in `packages/policy-kernel/src/index.ts`. P8 asks whether those should move onto the same engine, and
whether pillar-4 membership needs a relationship-based (Zanzibar) store alongside Cedar.

## Inventory of the hand-written evaluators

All of them are pure, synchronous and zero-I/O. The gateway loads the rows; the kernel decides. Each one writes a
`RuleTrace` entry and a reason string, and many tests pin those byte for byte.

| # | Evaluator (kernel) | What it decides | Fit for Cedar |
|---|---|---|---|
| 1 | Tool grant chain (`evaluateTool`): direct tool grant → role tool grant → read-only-all → role read-only-all, minus revocations (full or `read_only`) | Whether the call is granted at all | **Poor.** Cedar would be asked to *grant*, which breaks ADR-0040 invariant 1 ("ABAC never grants"). The ordered precedence, per-step `revoked`/`no-match` trace and the reasons that quote the grant do not come out of Cedar's flat `reason` set. They would have to be rebuilt in TypeScript around it. |
| 2 | Agent grants and connector grants (`evaluateAgent`, `evaluateConnector`), with revocations, mode, ceiling and object scope | The same question for agents and connectors | **Poor**, for the same reasons as #1. |
| 3 | Team-Lead ceiling (`ceilingTools`) | A worker cannot exceed its lead | Possible (`context.ceiling.contains(resource.name)`), but it is a single `includes`. Moving it gains nothing. |
| 4 | Data-scope rules (`argAtPath`, `allowedValues`) | Whether a call argument is inside an allow-list | **Semantic gap.** Dot-paths into untyped call arguments, "missing or not a scalar fails closed", and `String(value)` coercion for numbers and booleans. Cedar records are typed, and absent paths raise errors. Doable with `has` chains generated per rule, but it is the riskiest one. |
| 5 | **Rate limits** (match predicate plus `currentCount >= maxCalls`) | Which configured limit, if any, this call exhausts | **Good.** One call site, it can only deny, the predicate is a plain conjunction of string comparisons and one integer comparison, and the output is a single limit. Delivered in slice 1. |
| 6 | Approval rules (`matchingApprovalRules`, ADR-0229 precedence, ADR-0104 strictest `approvalScope`) | Whether a call pauses and who approves | **Good for the match, not for the ordering.** The match predicate is the same shape as #5 plus `writeOnly`. Precedence and the scope roll-up stay TypeScript because Cedar returns an unordered set. Candidate for slice 2. |
| 7 | Execution gate and hold, kill switch (`executionGate`, `executionApprovalHold`) | Halted, read-only, per-subject halt, deployment-wide hold | **Leave.** These are a four-value operator dial checked before everything else. Putting them behind a wasm call adds a way for the stop button to fail. |
| 8 | AI-literacy gate (`literacyGate`) | Refuse when the person is not current on training | **Leave.** A single boolean from the gateway. |
| 9 | Actor-chain checks (ADR-0188 S2: chain validity, delegation depth, scope, budget, actor allow-list) | Delegated calls stay inside the initiator's entitlements | **Leave for now.** The actor's own Cedar verdict already runs on v4. The structural checks are about chain shape, not attributes. |

## Assessment of the move

**Semantic gaps.** Cedar is typed and errors where JavaScript coerces. For rate limits the only gap is a count that
is not a safe integer (`1.5`, `NaN`): JavaScript compares it, but Cedar cannot represent it as a `Long`. The Cedar
evaluator treats that as an evaluation error, which denies. Both columns are integers in Postgres, so a real row
never hits this gap. Approval rules have no further gap. Data scope has the gaps listed in row 4.

**Fail closed.** Cedar skips a `forbid` whose condition errors and lists it in `diagnostics.errors`. If those
errors are ignored, the error reads as "nothing matched", which fails open. Every Cedar evaluator here treats any
engine failure, any per-policy error or any thrown exception as a deny, as ADR-0188 S2 already does for v4 ABAC.

**Audit and explanation parity.** Cedar reports *which* policies matched, not why the others did not. Parity is
kept by mapping the matched policy back to the stored rule, and by keeping the kernel's trace and reason code where
it is. For rate limits the Decision is identical: same effect, rule id, trace and reason. The differential test
proves it. An engine error adds one new rule id, `rate-limit-engine-error`.

**Performance (measured 2026-11-07, Node 22, 4-core sandbox, `cedar-wasm` 4.14.0).** Microseconds per check, after
warm-up:

| Rate limits on the call | Hand-written | Cedar (policy set parsed once and cached) |
|---|---|---|
| 1 | 0.08 | 232 |
| 5 | 0.12 | 397 |
| 20 | 0.21 | 1 360 |
| 100 | 1.9 | 6 165 |

For comparison, today's ABAC check with one policy (stateless, schema-validated) costs **1 292 µs**. Profiling shows
the cost is passing data from JavaScript into WebAssembly, not Cedar's evaluation: about 50 µs per entity or context
record, and about 50 µs per call with no data at all. Passing the limits as a context record instead of entities makes
no measurable difference. Parsing the policy set per call costs about 5× more, so the set is preparsed once per size
(`preparsePolicySet` / `statefulIsAuthorized`, cached up to 256 limits).

Sending every limit to Cedar made a check that took nanoseconds take a few hundred microseconds. The synchronous
wasm call also blocks the Node event loop, and `governedEvaluate` can run the kernel up to three times per call.

**Review finding 1 (2026-11-08): only possibly-exhausted limits reach Cedar.** Exhaustion
(`currentCount >= maxCalls`) is a conjunct of every rate-limit policy. A limit whose counts are both safe integers and
not exhausted can therefore never be Cedar's answer, and the evaluator drops it before the call. Limits with a count
Cedar cannot represent are kept, so they still fail closed. The survivors keep their original order and are the
caller's own objects, so the reported limit is unchanged. Cedar still decides every match. Microseconds per check,
measured on 2026-11-08 on the same machine:

| Limits on the call | Hand-written | Cedar, none exhausted | Cedar, one exhausted | Cedar, unfiltered (before) |
|---|---|---|---|---|
| 1 | 0.14 | 0.08 | 158 | 205 |
| 5 | 0.08 | 0.10 | 134 | 453 |
| 20 | 0.21 | 0.16 | 124 | 1 162 |
| 100 | 1.0 | 0.66 | 168 | 6 107 |
| 300 | 3.3 | 2.1 | 124 | 77 370 |

The common case, where no limit is exhausted, makes no wasm call and costs the same as the hand-written code. A call
that is about to be denied pays one wasm call of about 0.12–0.17 ms, whatever the number of limits. The uncached
path above 256 limits is reached only when more than 256 limits are exhausted at once.

The fixed cost of a wasm call still rules out putting every remaining evaluator on Cedar one call each. A later slice
should batch all Cedar-backed rule types into **one** `isAuthorized` call per governed call, with the same
pre-filtering where a conjunct is cheap to test. Approval rules would ride on the rate-limit request, so the fixed
~50 µs is paid once.

## Decision

1. **Slice 1: rate limits move onto Cedar** (`packages/policy-kernel/src/rate-limit-cedar.ts`).
   - Each limit is a `RegulAIt::RateLimit` entity carrying its fields. Each limit also gets a `forbid` policy that
     names the entity only by its position. Policy text therefore never contains a stored value, so a tool name such
     as `x") || true || ("` cannot change a policy.
   - The policies are validated against a small schema (`RATE_LIMIT_CEDAR_SCHEMA_TEXT`).
   - The lowest matched position is reported, which is the legacy "first in input order".
2. **The kernel stays dependency-free.** `index.ts` defines a `RateLimitEvaluator` interface. The hand-written
   predicate becomes `legacyRateLimitEvaluator`, the default whenever a caller passes none, so every existing kernel
   test runs unchanged. The Cedar evaluator is loaded only through `@regulait/policy-kernel/rate-limit-cedar`, as
   `abac.ts` is. The gateway injects it (`EvaluationInput.rateLimitEvaluator`).
3. **Default-deny holds.** If an evaluator returns an error or throws, the call is denied with rule id
   `rate-limit-engine-error`. The evaluator is not called when there are no limits.
4. **The switch, for one release.**
   - The gateway default is Cedar.
   - `REGULAIT_RATE_LIMIT_EVALUATOR=legacy` keeps the hand-written evaluator. Any value other than unset, `cedar` or
     `legacy` refuses the boot.
   - The choice is written to the boot posture block (`rate limits: Cedar (cedar-wasm@…)` or `legacy hand-written
     evaluator …`).
   - Outside the boot path, an invalid value gives an evaluator that denies every call.
   - The switch and `legacyRateLimitEvaluator` are deleted in the release after this one, together with the
     differential test's legacy side. That removal is tracked in PENDING P8.
5. **Proof of agreement.** `rate-limit-cedar.test.ts` generates limits and calls with fast-check, from small pools so
   that matches, near-misses and every scope shape occur often. It runs 5 000 verdict comparisons, 2 000 full kernel
   `Decision` comparisons and 20 runs above the cache size. The two evaluators must agree on every one.
6. **Later slices (proposed, not built):**
   - Slice 2: the approval-rule match, with precedence and scope roll-up staying in TypeScript, batched into the same
     Cedar request as rate limits.
   - Slice 3: data scope, only once a typed argument model exists.
   - The grant chain, the execution gate, the literacy gate and the actor-chain checks stay hand-written, for the
     reasons in the inventory.

## Relationship-based store for pillar-4 membership

Today membership is one flat level. `project_members(project_id, user_id, role)` holds the role
(owner/contributor/viewer), and `team_id` on that row records provenance only. A team grants nothing. The checks are
"is this user a member, with at least this role" and "list my projects", both single indexed queries.

Candidates checked under ADR-0176, 2026-11-07:

| Candidate | Licence | Maintained | Air-gapped | Shape |
|---|---|---|---|---|
| OpenFGA (CNCF) | Apache-2.0 | Yes. Server releases through 2026 (v1.18.x); `@openfga/sdk` 0.9.7, 2026-08 | Yes, self-hosted, Postgres backend | Go server, run as a sidecar |
| SpiceDB (AuthZed) | Apache-2.0 | Yes. v1.5x releases through 2026; `@authzed/authzed-node` 1.6.1 | Yes, self-hosted, Postgres backend | Go server, run as a sidecar |
| Ory Keto | Apache-2.0 | Yes, but quieter (client 26.2.0, 2026-05) | Yes | Go server |
| Permify | Server reported as AGPL-3.0 (its Node client is Apache-2.0) | Yes | Yes | **Excluded:** AGPL in a shipped component |
| Cedar entity hierarchy (already shipped) | Apache-2.0 | Yes (4.14.0, 2026-11) | Yes, in process | `User in Team`, `User in Project` parents in the request's entities |

**Recommendation: do not add a Zanzibar store now.** With a one-level graph, a separate service brings these costs
and no capability:

- a second store to keep consistent with Postgres (dual writes, or a change feed that can lag);
- a service to patch, secure and run in BYOC and air-gapped installs (pillar 3);
- one more network hop in the enforcement path, which is exactly what ADR-0040 chose Cedar to avoid.

Membership facts Cedar needs are passed as entity parents (`principal in RegulAIt::Project::"…"`), loaded from
`project_members` with the request. Cedar's `in` already resolves hierarchies, so that is relationship-based
evaluation without a new store.

**Re-open the decision if any of these become true:**

- membership becomes recursive (teams or groups granting project access, nested groups);
- "list every object user X can reach" must run across millions of rows;
- several RegulAIt control planes must share one authorisation graph.

**If it is re-opened, OpenFGA is the first choice.** It has CNCF governance, an Apache-2.0 server, a Postgres
backend and an official Node SDK. It would run *alongside* Cedar: OpenFGA answers "is X related to Y", which becomes
an entity parent or a context fact; Cedar and the kernel still decide. SpiceDB is the alternate.

## Consequences

- Rate-limit decisions are made by Cedar in every gateway that has not set the legacy switch, and the Decision is
  unchanged.
  - CI runs the gateway suites on the default (Cedar) setting only.
  - The `legacy` setting was run locally on 2026-11-08 against Postgres: `rate-limit`, `a4-mode-dimension`,
    `policy-simulation` and the switch test, 54/54 on each setting.
- Cost after review finding 1:
  - No extra cost for a call with no limits, or with no exhausted limit.
  - About 0.12–0.17 ms for a call where at least one limit is exhausted.
- The preparsed policy-set cache is bounded by size, never evicted, and holds at most 32,896 parsed policies. Only
  sizes equal to a count of simultaneously exhausted limits are ever built.
- New rule id `rate-limit-engine-error`. Audit consumers that alert on rate-limit denials should include it.
- New boot-refusal case: an unrecognised `REGULAIT_RATE_LIMIT_EVALUATOR`.
- No new dependency: `@cedar-policy/cedar-wasm` 4.14.0 is already pinned and listed in `THIRD_PARTY.md`.

## As built: decision 4 executed (2026-11-14, ADR-0251 lane L1)

The release after slice 1, as decision 4 scheduled:

- `legacyRateLimitEvaluator` is deleted from `packages/policy-kernel/src/index.ts`. With rate limits and **no**
  evaluator the kernel now refuses the call (`rate-limit-engine-error`, "no rate-limit evaluator is configured"):
  an unconfigured engine is never an allow (ADR-0180). The only production caller (`governedEvaluate`) always passes
  the Cedar evaluator; kernel and gateway tests that call `evaluate` directly inject it.
- `REGULAIT_RATE_LIMIT_EVALUATOR=legacy` now **refuses the boot**, naming the removal; unset or `cedar` is the only
  accepted value (`docs/deployment/INSTALL.md` updated). The boot log line names the Cedar engine.
- **The differential test stays.** `rate-limit-cedar.test.ts` keeps an independent transcription of the old predicate
  as its oracle (`referenceRateLimitEvaluator`), so the 5,000-verdict, 2,000-Decision and past-the-cache properties
  still hold the Cedar evaluator to the exact pre-move answers. Writing it out caught one subtlety worth recording:
  the old `matchesScope` treats only a `null` tool name as "every tool"; an absent (`undefined`) one matched no tool.

## As built: slice 2, the approval-rule match on Cedar (2026-11-14, ADR-0251 lane L1)

- `packages/policy-kernel/src/approval-rule-cedar.ts` (`@regulait/policy-kernel/approval-rule-cedar`): each MCP
  approval rule is a `RegulAIt::ApprovalRule` entity with its fields, and one `forbid` policy per rule names it by
  position only (no stored value reaches policy text). Schema-validated, preparsed per size up to 256 rules. Cedar
  answers WHICH rules bind the call; ADR-0229 precedence and the ADR-0104 strictest-scope roll-up stay TypeScript.
- **Kernel:** `ApprovalRuleEvaluator`, `matchingApprovalRulesWith(evaluator, rules, ctx)` and
  `EvaluationInput.approvalRuleEvaluator`. An evaluator error or throw denies (`approval-rule-engine-error`); an error
  never reads as "no rule binds". With no evaluator the kernel keeps the hand-written `matchingApprovalRules` for one
  release, as decision 4 did for rate limits.
- **Gateway:** `governedEvaluate` injects the Cedar evaluator into the kernel call AND uses it for its own reads of the
  matched rules (the consent's approval scope, and the queue's quorum in `servedApprovalRules`), so the gateway and the
  kernel cannot disagree about which rules govern a call. The queue-quorum read fails closed on an engine error; the
  scope read falls back to the strict default while the kernel refuses the call on the same error.
- **Batching, measured against the plan.** The plan was to ride approval rules on the rate-limit request. It is not
  needed: the rate-limit evaluator makes no wasm call unless a limit is exhausted (and then the call is refused before
  the approval step), so in practice each call makes at most one wasm call either way. The approval evaluator
  pre-filters rules bound to another server or to another user (conjuncts of every policy), so a call with no rule
  that could bind it makes no wasm call.
- **Proof of agreement.** `approval-rule-cedar.test.ts`: 5,000 generated matched-set comparisons in precedence order
  (filtered and unfiltered evaluators), 2,000 full kernel `Decision` comparisons, 10 runs past the cache size, the
  pre-filter's zero-wasm case, fail-closed on error and on throw, and schema validation with no stored value in policy
  text.
