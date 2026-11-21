# ADR-0327: Replace a rule-like AI step with a deterministic rule (detect, suggest, shadow, approve, revert)

- **Status**: Accepted (owner direction 2026-11-15 via lane E12 brief; slice 1 built)
- **Date**: 2026-11-15
- **Index**: **Rule-like AI step → deterministic rule (pillar 6): find AI steps whose output is an exact-match function of a few input fields (held-out agreement, strict org-tunable floors), suggest a readable rule table with test cases and projected savings, run it in shadow, switch only on an approval, revert in one action; inputs outside the table always fall back to the AI. Off by default.**
- **Backlog item**: owner direction 2026-11-15 (lane E12, item 1); PENDING fragment `2026-11-15-e12-rule-like-steps-pending.md`
- **Built in**: lane E12, one PR per slice (slice 1: this ADR and the detector in `packages/optimizer-kernel/src/rule-induction.ts`)
- **Migration**: none in slice 1; slice 2 adds `pending/rule_step_detection.sql` (settings, suggestions and a scan index on `trace_spans`), numbered at merge
- **Related**: [TOKEN_OPTIMIZATION_SPEC §8, §12](../product/TOKEN_OPTIMIZATION_SPEC.md), ADR-0172 (builder agents),
  ADR-0044 (eval harness), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (3NF, security
  checklist), ADR-0251 (one governed decision core), ADR-0252 (merge-time numbering), ADR-0328 (repetitive ask →
  smaller model, the same shadow/approve/revert pattern)

## Context

Owner direction (2026-11-15), quoted from the lane brief: "detect workflow steps that use AI but behave like fixed
rules, and offer to replace them with a deterministic script to save cost." Opt-in local fine-tuning is post-pilot
(recorded separately, post-pilot) and is not part of this decision.

Facts read from the code on `main` (19f2a1f1):

- The workflow kernel has no AI classification stage type (`EXECUTABLE_STAGE_TYPES`,
  `packages/workflow-kernel/src/index.ts`). The AI steps that triage, label, route and summarise are builder agents
  (ADR-0172; `apps/gateway/src/builder-catalog.ts`, e.g. `incident-triage`), run by `runBuilderTurn`
  (`builder-runtime.ts`), and the LLM review check (`workflow-review-checks.ts`).
- Each governed call can leave a `trace_spans` row with `input_preview` and `output_preview` when capture is on, linked
  to `usage_events` (measured `cost_usd`) by `usage_event_id`. Estimated savings go to `cost_events` with a `technique`
  and an `estimation_basis`, and project cost reporting already sums them per technique.
- Approvals are rows in `approvals` decided through `POST /v1/approvals/:id/decide`, which dispatches on `object_type`
  to an `apply…ApprovalDecision` function in the same transaction.
- The deployment is single-tenant: "per org" settings are a singleton row (`model_drift_settings` is the pattern:
  `enabled` default false, step-up to relax, audit row in the same transaction).
- There is no in-process script sandbox in the repo (no isolated-vm, QuickJS or `node:vm` in product code).

Open source search (ADR-0176): `ml-cart` (MIT) last released 2022-01 and fails "maintained"; `decision-tree` (MIT) is
ID3 over categorical fields only, last released 2025-09 (over 12 months), with a lodash dependency; `ml-random-forest`
depends on `ml-cart`. `ydf` (Apache-2.0) ships inference-only JS packages last released 2024. scikit-learn (BSD-3) is
maintained but needs a Python engine image. Exact-match table induction itself is a group-by with a held-out check,
about 150 lines, and the thresholds and fallback semantics are RegulAIt policy, so slice 1 writes it. Decision-tree
induction over numeric ranges is deferred to a sandboxed engine image with scikit-learn, following the existing
`engines/` pattern, if exact-match tables prove too narrow.

## Decision

1. **Detector (slice 1, read-only).** `induceStepRule(runs, options)` in `@regulait/optimizer-kernel` takes one step's
   recorded runs (structured input fields and the output) and returns the smallest set of input fields (0 to
   `maxFields`) whose exact-match table reproduces the output, or a reason it is not rule-like.
   - Agreement and coverage are measured on held-out folds (deterministic, by run index), never on training rows.
   - A cell is trusted only with at least `minCellSupport` runs and a majority share of at least `minAgreement`.
     Impure and thin cells are left out and fall back to the AI.
   - Outputs must be enumerated (at most `maxOutputClasses` distinct values after trimming and collapsing whitespace;
     case is kept). Free text is never rule-like.
   - Strict defaults: `minRuns` 200, `minAgreement` 0.99, `minCoverage` 0.9, `minCellSupport` 5, `maxFields` 3.
     An org may tighten any of them and relax only down to the floors (50, 0.95, 0.5, 3). Search size has hard ceilings
     (`maxFields` 4, `maxCandidateFields` 32, `maxRuns` 20 000, `maxCells` 1 000). Worst case at the defaults
     (5 000 runs, 24 candidate fields) is about 3 s, so detection runs as a background job, not on a request.
   - Inputs are extracted from a recorded JSON object (top level and one nested level of scalars). A preview that is
     not a JSON object, including a truncated one, is skipped, never guessed.
2. **Suggestion (slice 2).** For a rule-like step the gateway stores a suggestion: the rule table rendered readably
   (one line per cell, "when severity = high and source = phone → on-call"), test cases drawn from history (each cell's
   recorded runs, plus fallback cases), and the projected monthly saving from the step's measured `usage_events` cost
   over the last 30 days times coverage. The "script" is **data, not code**: a table executed by `applyInducedRule`.
   Nothing is generated, compiled or evaluated, so it has no network, no file system and a runtime bounded by the
   number of cells by construction. This is a stricter posture than a sandboxed script, and it is the reason no sandbox
   is added.
3. **Shadow, approval and switch (slices 3 and 4).** Shadow mode runs the rule beside the AI for a configured period
   and records agreement on live traffic. The switch is an `approvals` row (`object_type` `rule_step_switch`) decided by
   a person through the existing queue; the decision, the switch and every revert are audited. Revert is one action and
   needs no approval. While switched, an input the table does not cover goes to the AI as before, and the rule's
   served share is reported as a `cost_events` technique (`rule_replacement`) with its estimation basis.
4. **Off by default.** A singleton settings row (`enabled` false): while off, nothing is computed. Enabling,
   relaxing a threshold and switching are step-up and audited (the `model_drift_settings` pattern).
5. **Scope guard.** This applies to AI steps that triage, route, label, classify, extract fields or produce templated
   summaries. It never applies to an authorisation decision: those go through the policy kernel and never call a
   model. The detector is fed only rows the caller may already read; it changes no routing or entitlement.

## Consequences

- Admins get a cost lever that is explainable: a table a person can read, with the evidence that produced it.
- A rule only covers inputs it has seen often enough; anything new still goes to the AI, so coverage, not accuracy, is
  what a switch gives up.
- The detector only sees what tracing captured. Where capture is off or inputs are not JSON, no step is ever
  suggested; slice 2 reports that count rather than hiding it.
- Numeric thresholds ("amount > 1000") are out of scope until a decision-tree engine lands.
- Security review note (not a finding under the scope guard): `workflow-review-checks.ts` lets an LLM review verdict
  fail an `automated_check` stage. It is a quality gate, fails closed and is not an authorisation decision; it stays
  as designed.

## As built (slice 2, lane E12)

- Tables `rule_step_settings` (singleton, absent = off; CHECKs repeat the kernel floors) and `rule_step_suggestions`
  (one row per agent and span name; `rule` is a point-in-time snapshot, the ADR-0200 exception), plus the partial
  index `trace_spans_llm_step_started_idx` for the scan. Written only by `apps/gateway/src/rule-steps.ts`.
- Routes, admin-only through the default gate and listed as known UI gaps for UI-D: `GET`/`PUT /v1/rule-steps/settings`,
  `POST /v1/rule-steps/scan`, `GET /v1/rule-steps/suggestions`, `POST /v1/rule-steps/suggestions/:id/dismiss`.
- Decision 2 said "background job"; slice 2 ships an admin-triggered scan instead, bounded to the 10 costliest steps,
  5 000 runs each and a 30-day window, and spaced 10 minutes apart by a compare-and-set on `last_scan_at` (database
  clock), so two replicas cannot run it at once. A scheduler entry can call the same function later.
- Test cases are the rule's own cells (input fields, expected output, support); no extra copy of captured inputs is
  stored. The saving is `window cost × (30 / 30 days) × structured share × held-out coverage`, labelled an estimate.
- A dismissed suggestion stays dismissed when a later scan refreshes its evidence.
- Review #862: induction runs on a worker thread (`induceStepRuleOffThread`, entry `@regulait/optimizer-kernel/offload`,
  Node's `node:worker_threads`, no dependency), one step at a time, with a 120 s timeout and a 256 MB heap cap. Measured
  on 5 000 runs × 24 fields: inline the event loop served no timer for 3.7 s; off-thread it kept ticking, with an
  identical result. A step whose worker fails or times out is reported as `induction_failed` in the scan's audit row.
- Review #862 (second round): `GET /v1/rule-steps/suggestions` answers through the shared ADR-0226 list contract
  (`RULE_STEP_SUGGESTIONS_LIST` with `answerListPage`, sort, cursor or offset, count), with its `status` filter
  defaulting to open suggestions, and `GET /v1/rule-steps/suggestions/export.xlsx` exports through `answerListExport`
  (audited). The export carries summary columns only, never the rule's cells.
- Not yet done, tracked for slice 3 (PENDING): the scan still answers when it finishes; answering 202 with the scan's
  audit id, so a proxy timeout cannot cut a completed scan's response, comes with the scheduler entry.
- Slice 3, first part (done): `rule_step_suggestions.rule` copies input values out of `trace_spans`, so
  - **retention:** the §8.3 prune pass (`runAuditPruneOnce`, the same floor that prunes traces) deletes every suggestion
    whose scan window `[detected_at − 30 days, detected_at]` starts before the cutoff (`rule-step-retention.ts`), so no
    cell outlives a span it was copied from (review #901: keying on `detected_at` alone let a suggestion detected
    inside the floor keep values from spans up to 30 days older than it); a rescan rebuilds it from spans still held;
  - **erasure:** privacy-ops locates the subject in a fifth store, `rule_step_suggestions` (each cell's key values and
    output, compared element by element), and an
    erasure deletes the matching suggestions rather than redacting a cell, which would leave a wrong rule. A later
    scan rebuilds them only from spans still held. Trace spans themselves are outside the locator today and are
    bounded by the retention floor; that is unchanged here;
  - **RLS:** both tables are classified deployment-wide in ADR-0234 (no row policy; admin-only routes).
- Slice 3b, shadow mode (migration `pending/rule_step_shadow.sql`):
  - `POST /v1/rule-steps/suggestions/:id/shadow` puts an open suggestion in shadow (refused while detection is off), and
    `.../shadow/stop` ends the period. Both are admin-only and audited in the same transaction. No step-up: shadow
    changes no routing and relaxes nothing; the switch (slice 4) is an approval.
  - Each shadow period is a row in `rule_step_shadows` (at most one open per suggestion). Its counters (`runs`,
    `covered`, `agreed`) are a measured read model of `trace_spans`, advanced by every scan through
    `evaluated_through`, a microsecond cursor kept as Postgres text, so no span is counted twice. When a pass hits the
    row limit, spans sharing the last start time wait for the next pass. The counts and the cursor commit with the
    scan's audit row.
  - The kernel's `tallyShadow` applies the rule with one key lookup per run (cost `runs + cells`), matching
    `applyInducedRule`.
  - While a suggestion is in shadow, a rescan does not touch its row (`setWhere status <> 'shadow'`), so the counts
    always describe the rule under test. The list shows each suggestion's latest period, with coverage and agreement.
  - Retention and erasure still apply: deleting a suggestion deletes its periods, which hold counts only.
- Slice 4a, the switch lifecycle (migration `pending/rule_step_switch.sql`). Nothing here serves the rule yet: slice
  4b puts it on the request path.
  - `POST /v1/rule-steps/suggestions/:id/switch` asks for a step in shadow mode to be switched to its rule. It needs a
    user identity (so the reviewer is provably someone else), a step-up (`settings_relax`), detection on, and a named
    active administrator other than the requester. It creates a `rule_step_switches` row and an `approvals` row
    (`object_type` `rule_step_switch`) bound to `rule_sha256`, the canonical-JSON digest of the measured rule, as the
    approval's ADR-0104 `arguments_digest`. At most one open (pending or switched) request per suggestion.
  - The one approvals decide path applies the decision in its own transaction. Approved: the suggestion moves
    shadow -> switched and its shadow period closes, but only while it is still in shadow and its rule still hashes to
    the bound digest (else the request is recorded `stale`). Denied: `rejected`, and the step stays in shadow. The
    requester can never decide their own request, by delegation or the admin override
    (`cannot_approve_own_rule_step_switch`).
  - `POST /v1/rule-steps/suggestions/:id/revert` takes a switched step back to the AI in one action, with no approval
    (it only removes the rule). Audited.
  - Both lifecycles are ADR-0348 machines: the suggestion's (`suggested`, `shadow`, `switched`, `dismissed`, with the
    new `switch` and `revert` events) and the request's (`RULE_STEP_SWITCH_MACHINE`). A BEFORE UPDATE trigger
    freezes the request's suggestion, digest, request time and requester. A rescan leaves shadow and switched rows
    alone. The reasons are prose-scrubbed (ADR-0102). RLS: deployment-wide (ADR-0234 appendix).
- Slice 4b (built, compat path): a switched step is answered by its rule on the Anthropic- and OpenAI-shaped
  (compat) surfaces.
  - **When the rule answers.** Re-checked on every call:
    - the suggestion is `switched` and its latest switch request is `switched`;
    - the rule still hashes to the digest the reviewer approved;
    - the input parses into the rule's fields, and an exact-match cell covers it.
  - **When the AI answers instead:** a tool-bearing or tool-forcing turn, a structured-output request, a passthrough
    call, and any input the rule does not cover. These go to the AI exactly as before.
  - **Same gates as the semantic cache.** The rule's answer goes through the one dispatch core as a candidate
    (`cachedResponse` plus `ruleStepServed`), the way an ADR-0119 cache hit does. Every input gate and the output PII
    and guardrail checks still run on it. The span and the audit rows say a rule answered, never a cache.
  - **Records.** A `rule_replacement` row in `cost_events` records the saving: the step's measured average AI cost
    per run over its scan window. No `usage_events` row is written. The span carries a `ruleStep` attribute, and
    detection and shadow measurement read only spans without it (`NOT_RULE_SERVED_SPAN`), so a rule never measures
    itself.
  - **Turning detection off does not unswitch a step.** Revert is the one way back to the AI, so a step's lifecycle
    state is never contradicted by a hidden setting.
- Slice 4c (built, native path): `/v1/agents/:agentId/invoke` serves a switched step the same way, after the
  path's hoisted PII and privacy gates and before the semantic cache, through the same dispatch core with the same span
  label, `rule_replacement` saving and audit row (`ruleStep` in its detail).
  - **Only a plain single-turn dispatch qualifies.** The rule was measured on spans whose input is `body.input` alone,
    so a conversation, a system prompt, attachments, a baseline or reference content each go to the AI.
  - A passthrough user keeps every AI call, as on the compat path.
- Slice 4d (built): a step can be switched to its **published decision table** instead of a detected rule.
  - **Same lifecycle and queue.** `POST /v1/decision-tables/:id/switch` (admin, a person, step-up, a named active
    administrator other than the requester) writes a `rule_step_switches` row whose subject is the published version
    (`decision_table_version_id`; exactly one of it and `suggestion_id` is set, migration
    `rule_step_switch_decision_table`). The approval is `object_type` `rule_step_switch`, bound to the version's body
    digest. `POST /v1/decision-tables/:id/revert` takes the table out in one action. The table detail shows the latest
    request (`switch`).
  - **Bound to one version.** The decide path switches only while that version is still the published one and its body
    still hashes to the approved digest; otherwise the request is recorded `stale`. Publishing a newer version reverts a
    live switch of the old one in the same transaction, so a newly published table never answers without its own
    approved switch, and the switch state never claims what the serve path no longer does.
  - **One live switch per step.** A table switch is refused while the step's detected rule is switched or asked to be
    (`step_switched_to_suggestion`), and the other way round (`step_switched_to_decision_table`). The two checks read
    under different row locks, so two concurrent requests could both pass; the serve path then prefers the detected
    rule, and either revert ends it (F1×S2, below rule 10's bar).
  - **Serving** uses the same path, gates, span marker and saving as slices 4b and 4c. The table compiles with
    `compileDecisionTable` to the same `InducedRule`; the saving is priced from the step's detector measurement when
    there is one, else recorded as null. The span, saving and audit carry `{switchId, suggestionId,
    decisionTableVersionId}`.

## Addendum: decision tables (owner approval 2026-11-17, competitor gap audit, Camunda row 6)

The owner asked that business users can write decision tables: a simple versioned table of conditions and outcomes,
validated by a schema, compiled to this ADR's rule engine (not a new engine), and published only on an audited
approval. This addendum records it; no new ADR.

- **Shape.** A table names up to 4 input fields (the names `extractStepFields` produces) and up to 200 rows. Each row
  gives every field one value, or a list of up to 20 values, and one fixed outcome of up to 200 characters. Values are
  text, finite numbers, true, false or null. There is no expression language, no ranges and no wildcard: a condition a
  person cannot write as exact values is not a decision-table condition. The zod schema in `decision-tables.ts` checks
  the shape; `compileDecisionTable` (`packages/optimizer-kernel/src/decision-table.ts`) checks the rest and reports
  every problem at once.
- **One engine.** `compileDecisionTable` expands each row's value lists into exact-match cells and returns the same
  `InducedRule` the detector produces, held to the same 1 000-cell ceiling, so `applyInducedRule` and the shadow tally
  run a table unchanged. Hit policy is UNIQUE (DMN's term): two rows that cover the same input are refused, whether the
  outcomes agree or not, so a table never depends on row order. An input the table does not cover goes to the AI.
- **Versions and approval.** `decision_tables` binds a table to one AI step (agent and span name, the suggestion key);
  `decision_table_versions` holds immutable versions. Proposing a version creates it `pending_review` with an
  `approvals` row (`object_type` `decision_table`) naming an active administrator other than the author. Only the one
  decide path publishes it (`applyDecisionTableDecision`, in the decision's transaction), and only if the version it
  was proposed against is still the published one; otherwise it is recorded `stale`. The author can never decide their
  own version, through delegation or the admin override (`cannot_approve_own_decision_table`). A denial records
  `rejected` and changes nothing. A version that compiles to the same cells as the published one is refused
  (`no_change`). At most one published and one pending version per table (partial unique indexes). Create, proposal
  and every decision outcome are audited (`object_type` `decision_table`).
- **Frozen and bound (security review of #1020).** A version is frozen once proposed. A BEFORE UPDATE trigger on
  `decision_table_versions` refuses any change to `body`, `body_sha256`, `table_id`, `version` and `base_version`,
  and lets `author_user_id` change only to NULL (the users FK's `ON DELETE SET NULL`), so only the status, the approval
  link and the decision columns move. `body_sha256` is sha256 over ADR-0060's `canonicalJson(body)`; the approval row
  carries the same value as its ADR-0104 consent fingerprint (`arguments_digest`). Publishing recomputes the digest
  from the stored body and compares it with both; on a mismatch the version is recorded `stale`
  (`decision_table_version_digest_mismatch`) and nothing is published.
- **Why not `config_versions` (ADR-0048).** The reviewer preferred reusing the shared version store, as compliance
  profiles do. It does not fit without changing a column other lanes depend on. Its lifecycle is draft, canary,
  active, rolled_back, superseded and retired, with canary percentages; a decision-table version needs `rejected`
  (the reviewer said no) and `stale` (approved against a base that moved, or a body that no longer matches), and has
  no canary. Adding them to `CONFIG_VERSION_STATUSES` would put two states into the machine every other artifact type
  shares. It is also polymorphic (`artifact_type` and `artifact_id` with no foreign key), where this table cascades
  with its agent. It has no database freeze either, so moving there would not by itself have closed the finding.
  Re-check if `config_versions` gains a per-type lifecycle.
- **Lifecycle (owner rule 12).** The shared ADR-0348 machine `DECISION_TABLE_VERSION_MACHINE` (`@regulait/shared`)
  declares the transitions once (publish, reject, mark stale from `pending_review`; supersede from `published`), and
  `transitionVersion` enforces each through `whereFrom`, a guarded UPDATE on the event's `from` states. Each version
  in the detail answer carries the machine's `lifecycle` description.
- **Routes** (admin-only through the default gate, API only; UI-D builds the editor): `GET`/`POST /v1/decision-tables`
  (the list under the ADR-0226 contract), `GET /v1/decision-tables/:id` (published and pending versions with readable
  rows and test cases, plus the latest 20 versions), `POST /v1/decision-tables/:id/versions`.
- **Publishing changes no routing.** The AI still answers the step. Serving a published table in place of the AI is the
  slice 4d switch, which needs its own approval and is bound to one version (above).
- **Open source (ADR-0176, compared in the slice PR).** DMN evaluators (`@hbtgmbh/dmn-eval-js`, `js-feel`) are stale
  with open advisories; `json-rules-engine` is outside the maintenance window and evaluates rules at runtime; GoRules
  ZEN evaluates its own expression language in a native binary; `dmn-js` carries a watermark clause outside the
  ADR-0176 licence list. None compiles to an exact-match lookup, so the compiler is ours. DMN 1.3 XML import and export
  through `dmn-moddle` (MIT, maintained, no evaluation) can map onto this shape later, limited to hit policy UNIQUE and
  literal values.
- **Data.** A table is configuration a person typed, not a copy of captured spans, so the trace retention floor and the
  privacy-ops locator do not apply to it; it is kept until its agent is deleted (cascade). RLS: deployment-wide
  (ADR-0234 appendix).

