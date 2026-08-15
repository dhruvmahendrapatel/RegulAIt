# ADR-0079: Make the plan-only stage real — a resting `planning` stage, invoke→instance attribution, and a default-deny mutating-mode rule

- **Status**: Accepted
- **Date**: 2026-08-15
- **Migration**: none. `workflow_instances.status` is a plain `text` column with no enum or
  check constraint, so the new `blocked_on_plan` value needs no DDL. No new table, no new
  column — the join point is a request field, not a stored dimension.
- **Driver**: the "Known follow-ups" entry in `project-state/STATE.md`: *"`planning` is a
  vocabulary item, not a control (pillar 2 §2 stage 2)"*. Closing it was explicitly a feature,
  not a fix.
- **Changes semantics of**: [ADR-0018](0018-workflow-engine-slice.md)'s kernel (the `planning`
  stage type). **Extends**: [ADR-0011](0011-shared-projects-on-one-project-entity.md) (the
  `assertProjectAttribution` refusal idiom this copies),
  [ADR-0016](0016-transitive-per-node-budget-ceiling.md) (the run-plan path it also guards).

## Context

`WORKFLOW_ENGINE_SPEC.md` §2 stage 2 promises:

> **Auto-enter Plan mode** — forced planning-only reasoning first, **no code/state mutation
> possible in this stage**.

Two halves of that were missing, and the code was honest about one of them. The kernel's own
comment read `planning is a mode marker, not a blocker here`: `runForward` auto-completed a
`planning` stage, so an instance never came to rest on it, and no consumer could ever observe
the marker. That is the first half.

The second half was structural and quieter. The **ordering** guarantee was — and remains — real
and already verified: nothing builds before sign-off, because the build stage sits after the
approval gate and `runGitExecutions` re-validates the current stage under a row lock. That is
not what was missing, and this ADR does not re-prove it. What was missing is narrower: while a
change is being planned, a direct `POST /v1/agents/:id/invoke` with `mode: "execute"` was not
constrained by the instance **at all** — because an invoke body carried `projectId` and never
an `instanceId`. There was no join point. Nothing to enforce against, and nothing to enforce it
on.

So the spec sentence was stronger than the code. This ADR closes the distance and states
precisely how far it closes.

## Decision

### 1. A `planning` stage RESTS (kernel semantics change)

`runForward` no longer walks through a `planning` stage. It parks: status `blocked_on_plan`,
effect `await_plan`, stage status `active`. Leaving it is an explicit act — a `human_trigger`
(or `stage_completed`) event on the planning stage, i.e. the existing
`POST /v1/workflows/instances/:id/advance` with no new endpoint and no new event kind. The
kernel also exports `currentPlanningStage(def, state)`, the single predicate for "is this
instance in plan-only right now", keyed on the stage TYPE at `currentStageIndex` (never on a
status string), and null for any terminal instance.

This is a **semantics change to a shipped kernel**, sanctioned by the brief that commissioned
this work. Its blast radius is recorded in full below.

### 2. Invoke→instance attribution, validated like `projectId`

`invokeAgentSchema` gains an optional `instanceId`. It is validated exactly the way
`assertProjectAttribution` validates `projectId` (`apps/gateway/src/projects.ts`): an unknown
instance is `400 invalid_reference`; an instance the caller may not drive is
`403 not_an_instance_participant`. **Never ignored** — a silently-dropped attribution is worse
than no attribution, because the caller believes a gate applied.

The authorization bar is the STRICT one the driving routes use (initiator or admin), not the
widened read gate `loadInstanceFor(…, {allowParticipant:true})` grants to named approvers.
Attributing agent work to somebody else's change is driving it, not reading it.

### 3. The mutating-mode rule: default-deny against a named plan-safe allow-list

The agent `mode` vocabulary is open (`z.string()`), so "mutating" cannot be read off an enum.
Rather than guess, the rule is stated:

> A mode is permitted at a plan-only stage **only if** it is one of
> `PLAN_SAFE_MODES = [plan, review, chat, ask, read]`, compared trimmed and lower-cased.
> **Every other mode — including one invented tomorrow — is mutating and is refused.**

Why this direction: a deny-list of known-mutating modes (`execute`, `apply`, …) fails **open**
on exactly the modes nobody thought of, which is the wrong side of the line for a control whose
entire purpose is "no mutation is *possible* here". Default-deny is also pillar 1's posture
everywhere else, so this is the house rule rather than a new one. The allow-list members are
the read/reason modes the codebase already dispatches with (`plan`, `review` and `chat` all
appear in the seed's own mix) plus the two obvious read synonyms.

The refusal is `409 plan_only_stage` — 409 because this is "the object is not in a state that
permits this", matching `invalid_workflow_state` / `invalid_run_state`; the distinct error name
is what makes it actionable. The message names **the instance, the stage, the allowed modes,
and the exact call that lifts it**. It applies regardless of `dispatch`: a decision-only invoke
sends nothing to a provider, but "mode: execute against this change" is the intent the stage
exists to refuse, and answering it would make the gate look optional.

### 4. The run-plan path, because it composed cleanly

`POST /v1/runs` already accepted a `workflowInstanceId` — **unvalidated**, so an unknown id
reached the insert and died on a foreign key. It now goes through the same
`assertInstanceAttribution`, and the same plan-only rule applied **per node** (a graph declares
one mode per node): while the instance rests at a planning stage, any node with a mutating mode
refuses the whole plan, naming the offending nodes. Refusing the graph rather than half-planning
it is the same choice the template merge makes for a conflicting stage.

The nested build-stage call (`workflows.ts` → `planRun(…, instance.id, …)`) passes the
instance's own id and initiator, and a build stage is never a planning stage, so that path is
untouched by construction rather than by an exemption.

### 5. Audit

A plan-only DENY is audited as `objectType: "workflow"`, `objectId` = the instance,
`ruleId: workflow-plan-only-stage`, so "what did this change's plan gate stop" is one query on
the instance's own trail — the reasoning ADR-0066 used for virtual keys. A permitted
instance-attributed call is audited too (`workflow-instance-attributed`, effect `allow`), since
an attributed invoke that *was* allowed is part of the same story. Attribution failures are not
audited, matching the project-attribution idiom they copy.

### 6. UI

`WorkflowDetailPage` gets a "Plan only" card in the page's existing idiom (the same shape as
the deploy-hold and failed-check cards): a warn badge, a plain statement of what is refused
(a mutating mode on a call naming this `instanceId`) and what still goes through, the honest
note that a call naming no workflow is not constrained, and one **Finish planning** button
posting the same `/advance` the refusal message names. `statusTone` maps `blocked_on_plan` to
`warn` — a normal resting state, not a failure.

## Blast radius of the semantics change (what had to move)

Every template with a `planning` stage now parks one step earlier. Found by sweeping the whole
repo for the stage type, not by waiting for failures:

| Where | What changed |
|---|---|
| `packages/workflow-kernel/src/index.ts` | `blocked_on_plan` status, `await_plan` effect, the resting branch in `runForward`, `planning` added to the human-triggerable types, `currentPlanningStage` exported |
| `packages/workflow-kernel/src/index.test.ts` | `startedPastPlan()` helper; the "start runs to the artifact stage" test split into "rests AT planning" + "leaving it is explicit"; +3 tests (38 → 41) |
| `apps/gateway/src/seed.ts` | `leavePlanOnly()` helper applied to all five seeded instances that must reach a later stage (Dana's standard change, the pipeline demo, Avery's HIPAA change, the cascade headline, the three deploy-tail instances). No-op for templates without a planning stage, so nothing is special-cased |
| `apps/gateway/src/workflow-pipeline.test.ts` | the e2e walk asserts `blocked_on_plan` then advances (and asserts the advance lands on `blocked_on_artifact`) |
| `apps/gateway/src/mcp-proxy.test.ts` | the two `standardDef` journeys (the full journey, and the compliance-cascade walk) leave plan-only first |
| `apps/gateway/src/org-settings.test.ts` | the quorum walk leaves plan-only first |
| `apps/web/src/ui/kit.tsx`, `.../WorkflowDetailPage.tsx` | the status tone and the new card |

Not affected, and checked rather than assumed: `template-gallery.ts`'s four built-in shapes and
the compliance-derived shapes (definitions only — nothing starts an instance from them);
`WorkflowTemplatesPage.tsx`'s example definition (still valid input); every other test template
in the repo, none of which declares a `planning` stage; `workflow_instances.status` (plain
text, no constraint).

## Non-vacuity evidence (M-002)

Two independent bypasses, each reverted; scratch DB dropped and recreated per run.

| Temporary bypass | Result on `plan-only.test.ts` |
|---|---|
| `planOnlyRefusal` returns `null` unconditionally (the gate neutered, attribution left intact) | **5 of 10 failed** — exactly the refusal tests (execute refused, default-deny vocabulary, the control's first assertion, the regression's first assertion, the run-path refusal). The attribution and resting tests stayed green, which is the point: they test different things |
| `runForward` restored to the pre-ADR-0079 planning no-op | **9 of 10 failed** — everything except the unknown-instance run check, which does not need the stage to rest |

Green on the reverted tree: 10/10.

## Honest limits

- **Attribution is OPT-IN, and that is the real remaining hole.** An invoke that names no
  `instanceId` is exactly as unconstrained as it was before this ADR — a caller who simply
  omits the field can still run `mode: "execute"` while a change is being planned. This closes
  the gap for calls that *declare* their workflow; it does not make declaration mandatory.
  Making it mandatory is a separate, larger decision (it needs a rule for every unattributed
  call in the product, the way ADR-0021's `defaultPiiMode` floor did for PII) and is not taken
  here. A test in `plan-only.test.ts` pins this limit rather than leaving it implied.
- **The rule constrains declared intent, not semantics.** Nothing stops a caller from writing
  code inside a `plan`-mode dispatch. The declared mode is the governed dimension everywhere
  else in this codebase (`agent_grants.allowedModes`, orchestration node `mode`, the
  mode-scoped restriction rules), and this reuses it rather than inventing a second, softer
  one. "No mutation is *possible*" remains stronger than what any mode-based control can
  deliver.
- **Other dispatch surfaces do not carry the join point**: the OpenAI/Anthropic compat shims,
  the MCP proxy and the conversations path have no `instanceId` and are therefore unconstrained
  by a plan-only stage. They were left alone deliberately — each has its own attribution shape,
  and widening the field across all of them without a mandatory-attribution decision would add
  surface without adding a guarantee.
- **No new billing dimension.** `instanceId` is a governance join point; cost still attributes
  through `projectId`. An instance-attributed invoke does not bill to the instance, because
  `usage_events` has no such column and inventing one would be a second, drifting attribution
  path.
- **A pre-ADR-0079 instance persisted mid-flow keeps its stored state.** Any instance already
  past a planning stage stays past it (`currentPlanningStage` reads the current index, so a
  completed planning stage is simply not current). Nothing is retroactively parked.
