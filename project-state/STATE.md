---
phase: governance-mvp-in-progress
last_updated: 2026-07-25
active_epics: [EPIC-02, EPIC-03, EPIC-04, EPIC-05, EPIC-06]
open_questions_open: []
last_session: sessions/2026-07-24-session-02.md
---

# RegulAIt — Project State

## Where we are (read this paragraph first)
The infrastructure bootstrap phase (EPIC-01) is **complete**. The private GitHub repo
[dhruvmahendrapatel/RegulAIt](https://github.com/dhruvmahendrapatel/RegulAIt) is live with the
full scaffold. AWS is a two-account Organization (Management `913436627353` / Workload
`regulait-dev` `517506432475`), IAM Identity Center only (no long-lived keys), and the full
security baseline — org-wide CloudTrail, GuardDuty, Security Hub (FSBP + CIS standards), AWS
Config with a cross-account aggregator, account-level S3 Block Public Access, a $5/month Budget,
3 SCPs, and all three permission sets (`Admin-BreakGlass`, `Deploy-Builder`, `ReadOnly-Audit`) —
is applied via Terraform (`terraform plan` reports zero drift). The `github-oidc-role` module is
authored but intentionally not wired into `main.tf` yet — no workload exists to deploy.
Full narrative, including two real incidents worth reading before touching this infra again, is
in `sessions/2026-07-21-session-01.md`.

**Product scope escalated twice more, 2026-07-24: now eight co-equal P0 pillars, not two.**
ADR-0007 (six pillars) added infra-ops/compliance-cascade/deployment-model, Shared Projects, and
a cost-per-project dashboard to
[GOVERNANCE_LAYER_SPEC.md](../docs/product/GOVERNANCE_LAYER_SPEC.md) (now §8–§10), and escalated
token/cost optimization to full P0 pillar in
[TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md). ADR-0008 (eight
pillars) added two more, each in its own new spec doc:
[MULTI_AGENT_ORCHESTRATION_SPEC.md](../docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md) (pillar
7 — PM→Team-Lead→Worker delegation, task-graph DAG, entitlement inheritance never escalation,
per-run budget caps) and
[PM_TOOL_INTEGRATION_SPEC.md](../docs/product/PM_TOOL_INTEGRATION_SPEC.md) (pillar 8 —
Azure DevOps/Jira/etc. as the system of record, not a shadow copy). `CLAUDE.md` and `VISION.md`
updated to list all eight. **No AWS/Terraform infrastructure change was needed for either
escalation** — nothing is deployed yet (EPIC-02 through EPIC-06 haven't started), so both were
spec-only updates.

**EPIC-02 started, 2026-07-24 (session 02).** Stack chosen and recorded as ADR-0009 (TypeScript
end-to-end: Fastify + official MCP SDK planned, hand-rolled pure policy kernel, Postgres +
Drizzle, pnpm monorepo). First vertical slice of MCP-server governance is **built and green**
(21 tests: 13 kernel unit, 8 gateway integration against Postgres 16): `packages/policy-kernel`
(default-deny, per-user×server×tool allow-lists, read-only-all server grants, typed
`Decision {effect, ruleId, ruleChain, reason}`), `packages/db` (schema + first migration:
users/mcp_servers/mcp_tools/tool_grants/server_grants/audit_log — audit rows deliberately have
no FKs so they survive deletions), `packages/shared` (zod schemas), `apps/gateway` (Fastify:
admin CRUD, `/v1/evaluate` writes an audit row for every decision, visible-tools endpoint
implements §3's visibility filtering). Work is on branch `claude/status-check-2gbrwf` (draft PR).
**Not yet in the slice**: initiatives object type, admin portal.

**Review fixes + git-provider abstraction (PR #10).** The PR #8/#9 adversarial reviews'
confirmed findings are fixed (2 critical: stage-scoped approval events kill cross-stage
approval forgery; transactional FOR-UPDATE event application kills decision races; plus
supersede-all on re-open/deny/abort, merge-conflict-throwing template merge, approver
validation at template creation, declared-modes enforcement, ceiling-preserving partial
agent-policy upsert, revocable agent/connector grants). Then `git_operation` became a real
executable stage type: new `packages/git-provider` (provider-neutral interface; GitHub REST
adapter with injectable fetch; in-memory mock for tests/air-gapped dev; GitLab/Bitbucket/ADO
interface-ready but explicitly rejected until implemented), `git_connections` with
AES-256-GCM-encrypted tokens (REGULAIT_DATA_KEY; storage refused without it, migration 0009),
and a gateway executor: create_branch → open_pr (body auto-linked to the signed-off
requirements artifact, §2 stage 7) → merge (configured strategy) with results in
instance.context, failures retryable via /advance, everything audited.

**Real model dispatch, 2026-07-25 — the estimates-to-actuals unblocker.** New
`packages/model-provider` on the git/pm-provider playbook: neutral `ModelProvider` interface
(`dispatch(model, input, …) → {outputText, stopReason, refusal, usage}`), an Anthropic adapter
on the official `@anthropic-ai/sdk` (injectable fetch — unit tests never touch the network;
`stop_reason: "refusal"` handled explicitly: refused content is NEVER surfaced as an answer),
an in-memory mock (input `<<refuse>>` triggers the refusal path for e2e tests), and a registry
that rejects openai/google/xai until implemented. Placement is the whole point: dispatch runs
strictly AFTER governance and AFTER routing in `/v1/agents/:id/invoke` (`dispatch: true`) — the
provider package is handed the served model id as an input and never picks one, so widening
entitlement is structurally impossible. Config problems fail explicit (409
`agent_not_dispatchable` / `no_model_credential`), never fall back to a different model.
Migration 0016: `agents.model` (provider-native id; null = decision-only),
`model_credentials` (one per provider, AES-256-GCM under REGULAIT_DATA_KEY, write-only API —
never returned), and `usage_events` — pillar 5's MEASURED actual-spend ledger, deliberately
distinct from estimate-based `cost_events`: provider-reported token counts × the served agent's
list price (unpriced = null, a measured token count never becomes an invented dollar), plus
`measuredCostSavedUsd` — what the routing baseline would have cost at the SAME measured
volumes — upgrading pillar 6's savings claim from estimated to measured per dispatch.
`GET /v1/usage-events` mirrors the cost-events read surface (admin fleet-wide, non-admins
forced to self; totals include measured spend + measured savings). Every dispatch is audited
(model, stopReason, refusal in the agent audit row). **Second slice: worker-node dispatch —
orchestration runs execute for real.** The dispatch core is extracted as a shared
`executeGovernedDispatch` and `POST /v1/runs/:id/nodes/:nodeId/dispatch` runs a started
(`in_progress`) node's work through it: the node's CURRENT owner is executed exactly as
assigned (no routing at execution time — owner selection already happened, entitlement-checked,
at plan/re-plan/reassign), and §5.1 is re-checked at dispatch time under the INITIATING user —
a grant revoked mid-run stops the worker cold (403, audited). The state machine stays
authoritative: dispatch produces output (returned + recorded as a `node_dispatched` entry in
the run's append-only history, truncated), it never moves the node; a worker refusal is
surfaced honestly and the node does not advance. §5.2 gains MEASURED enforcement alongside the
estimate-based node-start gate: `budget.measuredSpentUsd` accumulates real dispatch cost; the
first cap crossing is allowed (measured cost is only knowable after the call) but escalates
immediately into the one approvals queue (`__budget__:<node>`, audited require_approval), and
every dispatch after it is blocked (409) until the named approver sanctions the overage.
usage_events rows carry `{runId, nodeId}` attribution. **Third slice: auto-dispatch of ready
nodes.** `POST /v1/runs/:id/auto` is a self-driving pass with the same gates and zero new
authority — one synchronous call (no scheduler/queue, ADR-0010's bias), starting the run if
needed then repeatedly taking the first ready node through the SAME machinery the manual
endpoints use: estimate gate → node_started → governed dispatch (§5.1 re-check per node) →
node_submitted. Review stays a human gate BY DEFAULT — nodes land in_review and dependents
wait; only an explicit `acceptReviews: true` also accepts each submission (audited in the
event history like any acceptance). Node-level problems (entitlement denial, config gap,
worker refusal) mark that node failed/blocked — §3's retry/reassign/escalate applies — and
the pass keeps driving independent branches; run-level problems (estimate or measured budget)
stop the whole pass, with the measured-budget check running BEFORE node start so a blocked
pass never strands a node in_progress. Per-node inputs via `inputs` map (title fallback),
`maxNodes` cap per pass, every pass summarized in one `run-auto-advance` audit row. **Fourth
slice: workflow build-stage nesting (§8 of both EPIC-03 and EPIC-05).** An `automated_build`
stage may carry a `run` config — an orchestration task graph, opaque to the workflow kernel
(the GATEWAY validates it with the orchestration kernel at template creation, plus the graph's
escalation approver — fail-fast, a template never promises a graph the engine can't run). The
stage then executes via the same `awaiting_execution`/`execute_stage` machinery as git stages:
the executor spawns a nested run through the same `planRun` the runs API uses, planned under
the **workflow initiator's** entitlements (a workflow can never launch a run its human
couldn't; an unentitled graph fails the stage explicitly with the plan rejection in
`context.lastError`, retryable via /advance once granted). The nested run is a first-class
run — visible at `/v1/runs/:id`, bound via `workflow_instance_id` (waiting since migration
0011), driven manually or by `/auto` — and the run-event funnel notifies the parent when it
turns terminal: completed → `execution_succeeded` (flowing straight into downstream stages),
aborted → `execution_failed` with the stage retryable (retry spawns a FRESH run; a live or
completed run is never duplicated — idempotent like branch creation). The kernel forbids
human-triggering a build-with-run stage — no bypassing the governed execution. **Fifth slice:
signed-off artifacts in nested-run worker prompts — §2's scope-lock made real.** When a
dispatched node belongs to a workflow-bound run, `buildNestedRunContext` injects the
workflow's SIGNED-OFF artifacts as the model's system context ("execute strictly within the
signed-off requirements below; do not expand scope") — the build executes against exactly
what was approved, never a re-imagined version. The build stage's `scope` narrows the context
to that one artifact; without it, the latest version of every artifact is included; artifact
edits re-open the workflow upstream, so a re-run always carries the re-signed version. §6
traceability: the exact `{output, version}` list that framed each execution is recorded in
the `node_dispatched` history entry. Standalone (non-workflow) runs stay system-free —
verified down to the provider call via the shared mock's dispatch log. **Sixth slice:
per-user model credentials (BYO key).** Migration 0017: `user_model_credentials` (unique per
user×provider, AES-256-GCM, write-only like every credential surface). Self-service
`POST/GET/DELETE /v1/users/:id/model-credentials` (self or admin; other users' credentials
are 403-invisible). Dispatch resolution order: the BILLING user's own credential → platform
`model_credentials` → explicit `no_model_credential` failure; the ledger records
`credentialSource` (user|platform|none) on every usage event and in the dispatch response —
spend on a user's key is visibly not platform spend. Verified end-to-end against a local fake
Anthropic Messages server: the real adapter's actual `x-api-key` header carries the user's
key when one exists, falls back to the platform key when deleted, and precedence is restored
on re-add. Not yet: streaming, multi-turn dispatch, openai/google/xai adapters.

**Pillar 5 lands — per-project cost dashboard rollup, 2026-07-25.** Migration 0018: a minimal
`projects` entity (name, cost-center for chargeback, budget + named budget approver, overage
flag — membership/sharing semantics deliberately deferred to pillar 4's Shared Projects; until
then any authenticated caller may attribute, noted) plus FK-free `project_id` attribution
columns on BOTH ledgers (cost_events estimates, usage_events actuals) and on
runs/instances/approvals. **Attribution at the point of every gateway call**, exactly as the
pillar demands: `projectId` on direct invokes (validated at entry), on run creation (every
node dispatch bills to the run's project), and on workflow instances (nested runs inherit it —
the whole Intake→build chain bills to one project). **Budget enforcement in the dispatch
core**: measured spend at/over budget blocks further attributed dispatches (409) with the
first crossing allowed-but-escalated into the ONE approvals queue (objectType "project",
`__project_budget__`, named budget approver); the decide endpoint's approve lifts enforcement
(audited), deny keeps it. **The dashboard**: `GET /v1/projects/:id/costs` (admin FinOps
surface) — measured totals + tokens + measured savings, showback breakdowns by user and by
agent/model, estimated-savings-by-technique from cost_events, budget-vs-actual
(remaining/overBudget/overageApproved), and a labeled last-7-days run-rate forecast to end of
month; `GET /v1/projects` lists per-project spend fleet-wide. Not yet: MCP-proxy cost-event
attribution, per-project (rather than global) overage windows.

**Pillar 4 lands — Shared Projects MVP, 2026-07-25 (ADR-0011).** Shared-Project semantics
extend the ONE `projects` entity (no second container): migration 0019 adds `teams` +
`team_members`, `project_members` (per-user Owner/Contributor/Viewer, decoupled from
home-team role, optional contributing team validated against real team membership), an
append-only `project_context_items` store, and `projects.arbiter_user_id`. **The context
store is §9.2 literally**: every write is a new revision with provenance (user, team,
timestamp, optional source artifact); the current value of a key is its highest ACCEPTED
revision; once a key exists a write must name the accepted `baseRevision` it is based on
(409 otherwise — read-before-write is explicit, never a silent overwrite); a stale-base
write is RETAINED but not accepted and routes to the project's named arbiter through the ONE
approvals queue (`__context_conflict__:<itemId>`); approve makes it the new current value,
deny keeps it retained-but-never-current — every side of every conflict is a permanent row.
An arbiter-less project rejects conflicting writes explicitly (422). **Promotion (§9.4)**:
`POST .../context/promote` copies a workflow artifact into shared context (key = output,
`sourceArtifactId` provenance) — only the artifact's own instance initiator may promote.
**§9.3 honored precisely**: membership widens context visibility and attribution ONLY — a
contributor with no agent grant still hits default-deny (tested); and per ADR-0011, once a
project has members, only members/admins may attribute spend/runs/instances to it (memberless
projects stay open pillar-5 buckets). Everything audited as objectType "project". Deferred:
cross-team cost rollup views (§9.5), §9.4's suggested UI, SCIM team sync.

**Pillar 3's centerpiece lands — the §8.3 compliance-classification cascade, 2026-07-25.**
Classifications are multi-valued FRAMEWORK tags (hipaa/pci-dss/soc2/custom — the spec defines
no strictness ordering among frameworks, so nothing invents one) on the one `projects` entity
(migration 0020, plus `teams.default_classifications` and admin-editable
`compliance_profiles` — the entire cascade expressed as data, per-tag: required workflow
templates, MCP default mode, audit-retention days, PII mode; policy-as-code via API, §5/§8.5).
Profiles compose ADDITIVELY: template unions, mcp tightens to read_only if any says so,
retention takes the max, pii takes the strictest of the three defined modes (block>warn>log —
an ordering the spec does define). **The workflow dimension is ENFORCED**: at instance
creation a classified project's required templates union into the matched set ("no manual
per-control setup") and can FORCE a workflow when no assignment rule matches — the §4
strictest-wins merge carries every added sign-off stage; the admin explicit-template escape
hatch cannot skip it. **The other three dimensions are declared, honestly**:
`GET /v1/projects/:id/compliance` returns the effective policy with per-dimension enforcement
labels (`enforced-at-instance-creation` vs `declared-not-enforced`) — the estimationBasis
discipline applied to compliance. **Reclassification is diff-then-approve** (the spec's most
concrete behavior): first classification applies directly (audited); any CHANGE computes the
before/after effective-policy diff, pends in `pending_classifications`, and opens a
`__reclassification__` approval for a named reviewer through the ONE queue — approve commits,
deny discards, never silent. **§9.3 precedence**: a member team whose default classifications
aren't covered by the project's is surfaced at member-add (response + audit row,
`governing: "project"`), never silently resolved. Deferred: enforcement points for
mcp-default/retention/pii (detector + pruning jobs), reapply-to-in-flight on reclassification
(diff covers the policy; in-flight instances keep their merged definitions), per-framework
cost-governance policies (§8.6→§10.3).

**Admin portal MVP, 2026-07-25 (ADR-0012).** One dependency-free HTML+JS file served by the
gateway at `GET /admin` — an auth-exempt STATIC SHELL (zero data, zero secrets; the admin
pastes an API key held in memory only) that is strictly a client of the public REST API, so
§5's policy-as-code parity holds by construction: the portal can be deleted without losing
any capability, and no state is UI-only. Tabs are §6's eight functional surfaces VERBATIM
(Users & Roles with the revocation/override layer, Agent Governance with enable toggles +
per-user entitlement views, Connector Governance, MCP Server Governance with the
auto-discovered tool inventory, Policy & Rules Engine over all three rule types, Audit &
Activity Log, the ONE Approvals Queue with inline decide, Simulation / Access preview over
/v1/evaluate) plus the §10.4-mandated Cost & Projects surface (budget-vs-actual + forecast +
showback + savings + compliance view per project). Gaps found while building were fixed as
API endpoints first (GET /v1/users, /v1/servers, /v1/servers/:id/tools, and the three
/v1/rules/* lists — all admin-gated). Deferred (per ADR-0012): SPA rewrite, SCIM/SSO status,
SIEM export, dry-run of UNSAVED policy, bulk actions, CSV export.

**Streaming dispatch, 2026-07-25.** Two layers, same gates. Provider layer: `dispatch()`
gains an `onText` delta callback; the Anthropic adapter uses the SDK's streaming API whenever
a caller wants deltas OR `maxTokens` exceeds 16k (long generations must not ride a single
request timeout), with `finalMessage()` returning the SAME complete result — accounting and
refusal handling identical to non-streaming (unit-tested against a faked Anthropic SSE body
through the injectable fetch: real SDK parse path, no network). The mock chunks its echo
deterministically so streaming is testable end-to-end. Gateway layer:
`/v1/agents/:id/invoke` accepts `stream: true` with `dispatch: true` — governance and routing
decide BEFORE any stream opens (denials remain plain JSON 403), then the response hijacks to
SSE: `delta` events as text arrives, one `result` event carrying exactly the JSON path's
payload, `error` events for post-headers failures. The audit row (flagged `stream: true`) and
measured usage ledger are written identically to the JSON path — streaming changes delivery,
never governance or accounting. Deferred: streaming for worker-node/auto dispatch (runs are
backend-driven, no client watching), multi-turn conversations.

**OpenAI model adapter, 2026-07-25 — the provider-agnostic principle made real at the model
layer.** `OpenAiProvider` in model-provider on the same playbook as the Anthropic adapter:
official `openai` SDK (v6) with injectable fetch, chat.completions with
`max_completion_tokens`, finish-reason mapping (stop/length/content_filter →
end_turn/max_tokens/refusal), `message.refusal` honored — a refusal's content is never
surfaced, matching the Anthropic discipline exactly — and streaming via `stream_options:
{include_usage: true}` feeding the same `onText` callback with the same complete-result
return. The registry now resolves anthropic + openai (apiKey required for both); google/xai
stay explicitly rejected. ZERO gateway changes were needed: credentials (platform + BYO-key),
routing, budgets, attribution, and streaming all already key off the provider string — the
e2e proves a `provider: "openai"` agent rides the whole governed pipeline against a local
fake chat.completions server (real adapter, correct Bearer key on the wire, measured usage
ledgered). **Google (Gemini) adapter, same day**: raw injectable
fetch — DELIBERATELY not the unified `@google/genai` SDK, which exposes no fetch injection
(untestable network code loses to plain REST; the git/pm adapters set the precedent) —
`generateContent`/`streamGenerateContent?alt=sse` with `x-goog-api-key` auth, incremental SSE
parsing feeding the same `onText` contract, finishReason mapping (STOP/MAX_TOKENS/SAFETY
family → end_turn/max_tokens/refusal) plus `promptFeedback.blockReason` → refusal (input
blocks and output filters both suppress content — same discipline). Registry now resolves
anthropic + openai + google; only xai stays rejected. Zero gateway changes again — e2e rides
a `provider: "google"` agent through the full pipeline against a local fake Gemini server
(correct header key + path on the wire, measured usage ledgered). **xAI adapter, same day — the registry is
complete.** Grok speaks OpenAI-compatible chat completions, so the chat-completions dispatch
core was extracted as a shared function (`dispatchChatCompletions`) and `XaiProvider` is that
core pointed at `https://api.x.ai/v1` by default — same contract, same refusal discipline,
same streaming accounting, provider-labeled errors. **All four real providers (anthropic,
openai, google, xai) + mock now resolve**; the "interface-ready but not implemented"
rejection era is over, and pillar 1's any-vendor routing claim is demonstrated across four
live adapters with zero gateway changes each time. Deferred: OpenAI Responses-API surface,
per-provider tool-use.

**Jira PM adapter, 2026-07-25 — pillar 8 grows its second real tool.** `JiraProvider` in
pm-provider: REST v2 deliberately (v3 forces ADF rich text; plain strings match the mapping
layer), Basic auth with the Jira Cloud `email:api-token` credential convention, injectable
fetch. The Jira-specific insight honored: **states are not settable fields** —
`transitionState` looks up the issue's available workflow transitions and executes the
matching one (by target-state or transition name), failing EXPLICIT with the available list
when the workflow offers no path (mirror failures surface, never fail the run event — the
established rule). `DEFAULT_MAPPINGS.jira` maps title→summary etc.; `blocked` is deliberately
unmapped (Jira's default workflow has no Blocked state — skip, never invent). Registry
resolves azure_devops + jira + mock; linear/asana/monday/generic_webhook stay rejected.
E2e: a run pm-syncs against a live-shaped fake Jira server (run parent + node issues created
with project/issuetype wrappers and Basic auth asserted on the wire) and a node_started event
mirrors through a real GET-transitions → POST-transition sequence. Deferred: remaining PM
adapters, ADF descriptions, Jira webhooks → the ADR-0010 normalized inbound shape.

**EPIC-06 started — PM-tool integration first slice, 2026-07-25.** New
`packages/pm-provider` on the git-provider playbook (pillar 8, PM_TOOL_INTEGRATION_SPEC
§2/§3/§6): neutral `PmProvider` interface (create/update/transition/comment/getWorkItem), the
load-bearing FIELD MAPPING layer as pure zod-validated config with per-adapter defaults an
admin overrides (§7: never hardcoded), an Azure DevOps adapter (REST 7.x, PAT, injectable
fetch, json-patch), an in-memory mock, and a registry that explicitly rejects
jira/linear/asana/monday/generic_webhook until implemented. Migration 0013: `pm_connections`
(AES-256-GCM tokens like git_connections) + `pm_links` — the record that makes a task-graph
node BE a work item rather than a shadow copy; RegulAIt stores ONLY the linkage. §3 source of
truth honored literally: priority/description/acceptance-criteria are never cached — the links
view reads them through live (`?live=true`) from the PM tool. Status ownership (documented
decision, spec silent): RegulAIt owns node status (it owns the state machine) and mirrors it
OUTBOUND via the mapping's statusMap on every node event; unmapped statuses are skipped, never
invented; mirror failures are surfaced in the response, never fail the run event, never hidden.
Every creation/mirror writes the one audit trail (objectType "pm_work_item"). Endpoints:
PM connection CRUD (admin), `POST /v1/runs/:id/pm-sync` (idempotent node→work-item linking),
`GET /v1/pm/links` (+live read-through). **Second slice: §5 approval
mirroring.** Mapping gains an `approval` section (`target: status_transition|comment` +
per-stage `stageMap`); pure `resolveApprovalAction` degrades everything unmapped to a comment —
a sign-off decision is never silently dropped (§4's fallback rule applied to approvals), and a
DENIAL never enters a mapped state (always a comment — a customer's "Approved" state is only
entered on approve). Workflow instances now link to ONE work item
(`POST /v1/workflows/instances/:id/pm-sync`, idempotent), and the decide endpoint mirrors every
decided workflow sign-off and run escalation onto its linked item (transition and/or
`[RegulAIt] sign-off …` comment with decider + reason) — strictly display, never a second
decision point; a mirror failure is surfaced in the decide response and never unwinds the
decision. All mirrors audited (pm_work_item). **Third slice: §4 decision
records.** First-class `decisions` table (FK-free — governance records survive deletion;
decision-maker is ALWAYS the authenticated identity, never a body field) with
`POST/GET /v1/decisions` scoped to the parent run/instance initiator. Mapping gains a
`decision` section (customer's Decision-like work-item type + field paths for
title/rationale/decisionMaker); pure `resolveDecisionAction` mirrors a recorded decision as a
real linked work item of that type — with a §6 traceability comment on the parent item — or
degrades to a tagged comment when no type is mapped; no PM link at all = recorded locally with
no mirror. Never dropped, never blocking the local record. Run pm-sync now also creates a
run-LEVEL parent item (anchor for run-scoped records; unblocks budget-approval mirroring
later). **Fourth slice: inbound sync
(ADR-0010 — webhooks + live read-through, no polling).** Per-connection webhook secret minted
at creation (plaintext once, sha256 at rest, constant-time verify — API-key discipline);
`POST /v1/pm/webhooks/:connectionName` accepts the normalized
`{externalId, event: updated|deleted|commented, state?, fields?}` shape (provider-specific
payload translation is a later adapter concern; this shape doubles as the start of the generic
webhook adapter) and is the ONLY route exempt from bearer auth. Every signal lands in
append-only `pm_sync_events`, matched or not. Inbound state is recorded on the link
(`inboundState`/`inboundAt`) and NEVER applied to the state machine — divergence from the
mapped state of the node's current status surfaces as `drift` in the links view plus a
`pm-drift-detected` audit row ("never drift silently" = detect-and-surface, not
auto-overwrite); `deleted` events orphan the link, audited. Not in EPIC-06 yet:
budget-approval mirroring, provider-specific webhook payload adapters + HMAC signatures,
automated drift resolution (human today), Jira + remaining adapters.

**EPIC-05 started — multi-agent orchestration first slice, 2026-07-25.** New pure
`packages/orchestration-kernel` (pillar 7, MULTI_AGENT_ORCHESTRATION_SPEC §2–§5): task-graph
validation (zod + cycle detection + §4 ownership rule: nodes sharing files must be
dependency-ordered), ready-set scheduling with `parallelizable:false` serializing the whole run,
and a run state machine using the spec's five node statuses (not_started/in_progress/blocked/
in_review/done) with §3's three failure outcomes — retry, reassign, escalate — all event-driven.
**The task graph is input** (user/template-supplied): whether a PM Agent may generate it with a
model call is an open spec question, deliberately deferred until real model dispatch exists.
§5.1 (inheritance, never escalation) enforced at the gateway: every node owner — at plan time
AND on reassignment — goes through the same `evaluateAgent` under the *initiating user's*
grants/modes/ceiling; any deny rejects the whole plan (422) or the reassignment (403), audited.
Escalations land in the ONE approvals queue (`approvals.run_id` + objectType "run", named
approver from the graph; approve = re-open node, deny = abort run) and every run event writes to
the one audit trail (objectType "run"). Migration 0011: `orchestration_runs` (graph/state jsonb
snapshots, nullable workflow_instance_id for §8 build-stage nesting later),
`orchestration_run_events` (append-only), `approvals.run_id`. Endpoints: POST /v1/runs
(validate+plan, nothing executes until an explicit start), POST /v1/runs/:id/events,
per-run view (initiator-only) + admin fleet view. **Second slice: §5.2 per-run budget caps.** Pure `estimateGraphCost`/`estimateNodeCost` in the
orchestration kernel (per-node token estimates — planner-declared or heuristic — × the owner
agent's list price; an unpriced owner nullifies the total, which fails CLOSED under a cap:
a cap that can't be checked requires approval, never silent skip, §7). Cap + breach action
(`approve`|`replan`) are admin-set on `user_agent_policies` — an explicit stand-in for the
per-project budget until a projects entity exists. Three §5.2 enforcement points, all
estimate-based (labeled as such in every payload) until real dispatch exists: (1) pre-execution
— over-cap plans either auto-re-plan (owners substituted per node via pillar 6's `routeModel`
with cost-sensitive bias over the entitlement-filtered candidate set — re-plan can never
escalate; substitutions ledgered as `cost_events` objectType "run") or gate `start` behind a
`__budget__` approval; (2) in-flight — `spentUsd` accumulates per node start, and a node whose
CURRENT owner (e.g. after reassignment to a pricier entitled agent) would breach the cap is
paused with a `__budget__:<node>` approval; (3) decisions — approve lifts cap enforcement for
that run (sanctioned overage, audited), deny aborts. Still not in EPIC-05: real worker dispatch,
PM-agent decomposition, team-lead tier, workflow build-stage nesting, per-project budgets.

**EPIC-04 started — token/cost optimization first slice, 2026-07-25.** New pure
`packages/optimizer-kernel` (pillar 6, TOKEN_OPTIMIZATION_SPEC §7/§8): deterministic complexity
classifier (never an LLM call — no text = no signal = no downgrade), token estimator, and
`routeModel()` — cheapest-eligible model selection with a relative tier floor per complexity,
§9 cost-sensitivity biasing (quality-sensitive = never downgraded), a §12 per-user passthrough
off switch, and full `{effect, ruleId, ruleChain, reason}` traceability. Routing runs strictly
*inside* governance at the same interception point: the candidate set is exactly the agents
`evaluateAgent` allows for that user+mode (re-enforced against the tier ceiling in the kernel as
defense in depth), so the optimizer can never widen entitlement. Savings semantics kept honest:
routing reports cost-saved (same tokens, cheaper model) against an explicit
`estimationBasis` — the counterfactual is the requested (baseline) model at list price; tokens-
saved stays 0 and is reserved for future compaction/dedup techniques. Migration 0010:
`agents.cost_per_mtok_in/out` (list price; unpriced models are never routing targets),
`user_agent_policies.routing_mode`, and the FK-free `cost_events` savings ledger (one row per
routing decision, per-technique enum covering all six §7 savings sources). `GET /v1/cost-events`
(admin fleet-wide, non-admins forced to self) returns raw events + per-technique totals —
the dashboard-ready §7 emitter that pillar 5's per-project rollup will consume. **Second slice
(same day): lazy tool-loading in the MCP proxy (§8)** — an optional `?intent=` on the proxy URL
(MCP's tools/list handshake carries no request text, so the signal rides on the URL) feeds pure
`selectTools()`: lexical relevance scoring narrows the *entitled* manifest to intent-relevant
tools, withheld tools stay fully callable (tools/call never consults the selection — the
manifest shrinks, the entitlement never does), no intent or zero matches fails open to the full
entitled list, the same per-user `routing_mode` passthrough switch disables it, and each
tools/list writes a `lazy_tool_loading` cost event with tokens-saved measured from the actual
serialized manifest chars withheld. **Third slice: §9 cost-sensitivity tag on workflow
templates** — `costSensitivity: cost-sensitive|standard|quality-sensitive` on the workflow
definition (validated by the kernel, no new stage type, no migration — it rides the definition
jsonb into the instance snapshot), merged strictest-wins in `mergeDefinitions` (an untagged
template counts as "standard", so a merge can never inherit cost-sensitive downgrading from
one team's template), surfaced top-level on the per-instance view. The invoke path has accepted
the same enum since slice 1; wiring instance→invoke happens when workflows actually invoke
models. Not in EPIC-04 yet: edit-vs-rewrite, compaction, file pre-processing, prompt/semantic
caching, batching.

**EPIC-03 started — workflow engine first slice (PR #9).** New pure `packages/workflow-kernel`:
declarative template validation (§3 — executable stage types trigger/planning/
artifact_generation/human_approval/automated_build/automated_check; git_operation/deployment/
rollback rejected until integrations exist), §4 assignment-rule matching (path glob/changeType/
environment, ANDed; multi-template union-merge keeping every approval stage, single trigger),
and a pure instance state machine: versioned sign-off (§2 stage 4 — artifact edits after
approval re-open the gate and supersede stale pending approvals), decide≠execute (build/check
stages await an explicit human trigger), denial/abort terminal states. Gateway: migration 0007
widens `approvals` into the ONE §6 inbox (workflow sign-offs are approvals rows with
object_type/instance_id/stage_id; deciding one advances the instance, all-named-approvers-must-
approve), plus `workflow_templates`/`workflow_assignment_rules`/`workflow_instances` (merged
definition snapshotted at start)/`workflow_events` (append-only history)/`workflow_artifacts`
(every version retained). Endpoints: template/rule CRUD (admin), instance start (auto-advances
to first block; §4: requester doesn't pick the workflow — rules do; explicit template =
admin-only), artifact submit/edit, advance, abort, per-instance dashboard view + admin fleet
view. Everything audits into the one trail (objectType `workflow`).

**§5 review fixes + agents/connectors governance (PR #8).** The PR #7 adversarial-review
findings are fixed: revocations are unique per (user, server, tool) with NULLS NOT DISTINCT
(migration 0005, duplicates deduped), Postgres constraint violations map to 409/400 instead of
500, and the entitlements view now surfaces tool-scoped carve-outs of role read-only-all grants
plus a `GET /v1/revocations` listing. Governance then extended to two more §2 object types
(migration 0006): **agents** — global registry (name/provider/tier/modes/enabled, §4), per-user
grants with mode-level restriction, per-user default+ceiling policy (tier-based), and a governed
`POST /v1/agents/:id/invoke` enforcement point (registry-enabled → allow-list → mode → ceiling →
allow, deny-by-default); **connectors** — catalog, per-user grants with read/readwrite mode and
`allowedObjects` data scope (fail-closed), governed `POST /v1/connectors/:id/invoke`. Both audit
into the **same** audit_log, widened with object_type/object_id/detail (§7's one audit trail).
Actual provider routing attaches to the invoke endpoints later — governance precedes routing.

**Roles + per-user overrides landed (PR #7) — §5 for the MCP object type.** Kernel: role-derived
grants (`RoleToolGrant`/`RoleServerGrant`, pre-filtered by the gateway to assigned roles) and
`Revocation` (subtractive per-user override; toolName null = all role-derived access on the
server). Precedence: direct grants > revocations > role-derived > default-deny — a revocation
never suppresses a direct grant, and revoked role grants trace as `revoked` (with the revocation
id) in the audit ruleChain. Gateway: migration 0004 (`roles`, `role_tool_grants`,
`role_server_grants`, `role_assignments`, `revocations`), role CRUD + assignment endpoints,
revocation create/delete (independently reversible per spec), and a per-user×server
**entitlements view** flagging every entitlement's source (direct vs role name) and any
revocation — §5's "override visibly flagged as a deviation", API-level.

**Real authn landed (PR #6) — the pre-ship blocker is closed.** Per-user API keys (`rgl_` +
24 random bytes, only the sha256 hash stored, shown once at creation, revocable, lastUsedAt
tracked), `users.isAdmin` flag, and a deploy-time `REGULAIT_BOOTSTRAP_TOKEN` (admin with no
user identity — exists only to mint the first real admin; cannot call tools or decide
approvals). Every gateway route now requires a valid Bearer token; everything is admin-only
except approvals-decide (named approver), own-visible-tools, and the MCP proxy (any user key).
The proxy's trusted `x-regulait-user-id` header is gone — identity comes from the key. The
approvals decide endpoint derives the decider from the authenticated identity (the old
body-supplied `deciderUserId` was spoofable). Migration 0003 (`api_keys`, `users.is_admin`).

**Data-scope rules landed (PR #5) — §3 feature-complete for the MCP object type.** Kernel:
`DataScopeRule` input (per-user×server, optional tool scope, dot-path into call arguments,
allowed-values list) — all matching rules must pass (AND), missing/non-scalar values fail
closed, violations deny before rate limits or approvals are consulted (order: grants →
default-deny → data-scope → rate-limit → approval → allow). Gateway: `data_scope_rules` table
(migration 0002), `POST /v1/rules/data-scopes`, and the proxy now passes each call's arguments
into `governedEvaluate` so scope is enforced on real MCP traffic.

**Approvals + rate limits landed (PR #4)**: the kernel now returns a third effect,
`require_approval`, and takes approval rules (per-user×server, optional tool scope, optional
write-only, named approver) and rate limits (per-user×server, optional tool scope, caller-supplied
usage counts — kernel stays zero-I/O) as inputs. Rule order: grants → default-deny (nothing
rescues an ungranted call) → rate limits (exhausted limit denies even with an approval in hand) →
approval rules → allow. Gateway: `approval_rules`/`rate_limits`/`approvals` tables (migration
0001), §6 Approvals Queue endpoints (`GET /v1/approvals`, `POST /v1/approvals/:id/decide` —
named-approver-only, 403 otherwise), rule CRUD, and proxy `tools/call` enforcement: paused calls
create/reuse one pending queue entry; approved entries are consumed atomically by exactly one
retried call (single-use); usage counting = audit-log allow rows in the limit's window.

**Session 02 continued**: CI added (`.github/workflows/ci.yml` — build + all tests on every
PR/main push against a Postgres 16 service container; PR #2, merged). Then the **real MCP proxy
path** landed (PR #3): `POST /mcp/:serverId` speaks streamable-HTTP MCP on both sides via
`@modelcontextprotocol/sdk` v1.29 (gateway = MCP server to clients, MCP client to upstream) —
`tools/list` auto-syncs the upstream tool manifest into `mcp_tools` (kind inferred from
`annotations.readOnlyHint`, defaulting to write) and filters through `visibleTools()`;
`tools/call` runs the kernel, audits every decision, and only forwards allows upstream. User
identity is an interim trusted header (`x-regulait-user-id`) until real authn lands. E2E-tested
with a real in-process upstream MCP server and real MCP client (26 tests total).

## Epics
| ID | Name | Status | Related |
|---|---|---|---|
| EPIC-01 | Bootstrap: AWS foundation + GitHub repo + session-continuity scaffold | **done** | ADR-0001–0004 |
| EPIC-02 | Governance layer MVP (now includes infra-ops/compliance-cascade/deploy-model, Shared Projects, cost dashboard — §1–§10) | **in progress** — stack chosen (ADR-0009), first slice = MCP-server governance vertical | GOVERNANCE_LAYER_SPEC.md, ADR-0007, ADR-0009 |
| EPIC-03 | Workflow engine MVP (now includes optional Design/Architecture sign-off stage type) | **in progress** — first slice merged (PR #9) | WORKFLOW_ENGINE_SPEC.md, ADR-0007 |
| EPIC-04 | Token/cost optimization MVP (escalated to P0) | **in progress** — routing kernel + cost_events ledger (PR #12), lazy tool-loading (PR #13), §9 workflow cost-sensitivity tag merged; real model dispatch built (model-provider + measured usage_events ledger — savings now measured, not just estimated) | TOKEN_OPTIMIZATION_SPEC.md, ADR-0007 |
| EPIC-05 | Multi-agent orchestration MVP (PM/Team-Lead/Worker delegation) | **in progress** — slices 1–2 merged (kernel/runs/escalations, §5.2 budget caps); worker-node dispatch merged (PR #18); auto-dispatch merged (PR #19); workflow build-stage nesting built (§8: automated_build spawns a governed nested run) | MULTI_AGENT_ORCHESTRATION_SPEC.md, ADR-0008 |
| EPIC-06 | PM-tool integration MVP (Azure DevOps/Jira/etc.) | **in progress** — slice 1 merged (PR #15); slices 2–4 built (§5 approval mirroring; §4 decision records; ADR-0010 inbound sync with drift detection) | PM_TOOL_INTEGRATION_SPEC.md, ADR-0008, ADR-0010 |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | **applied**, zero drift | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | **applied** (Admin-BreakGlass imported from its manual bootstrap creation, other two created by Terraform) | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | **live and private**: https://github.com/dhruvmahendrapatel/RegulAIt | EPIC-01 |
| COMPONENT-05 | Admin portal | **MVP shipped** — single-file API-client portal at /admin (ADR-0012), §6's eight panels + §10.4 cost surface | EPIC-02, ADR-0012 |
| COMPONENT-06 | Policy/allow-list engine | not started | EPIC-02 |
| COMPONENT-07 | Workflow orchestrator | not started | EPIC-03 |
| COMPONENT-08 | caveman (output token compression, Claude Code plugin) | **installed**, user scope, no restrictions (verified fully local) | ADR-0005 |
| COMPONENT-09 | graphify (code knowledge graph, Claude Code skill) | **installed**, project scope, restricted to `--code-only` (verified) | ADR-0005 |

## Decisions
See [docs/decisions/README.md](../docs/decisions/README.md) for the full ADR index. All nine
ADRs (0001–0009) are Accepted. ADR-0009 (2026-07-24) chose the product stack: TypeScript
end-to-end — Fastify gateway + official MCP SDK, hand-rolled pure policy kernel (typed
`Decision` object, no OPA/Cedar), Postgres + Drizzle, pnpm-workspace monorepo
(`apps/gateway`, `packages/policy-kernel`, `packages/db`, `packages/shared`).

## Open Questions
None open. OQ-004 fully resolved: (a) caveman + graphify installed and documented (ADR-0005);
(b) standing policy for future scaffolds recorded (ADR-0006, no implementation yet — nothing to
apply it to until EPIC-02/03 produce a first template); (c) full product-feature spec written —
[docs/product/TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md), explicitly
scoped as a standard feature area (not a third P0 pillar), reusing the governance layer's
per-user entitlement system for model routing and the workflow engine's tag mechanism for a new
cost-sensitivity tag — cross-referenced from VISION.md §5.

OQ-001 (region allowlist) defaulted to `["us-east-1", "us-east-2"]` and is applied as the
region-allowlist SCP; OQ-002 (budget cap) resolved to $5/month; OQ-003 (GitHub account) resolved
to personal `dhruvmahendrapatel`.

## Known follow-ups (not urgent, not blocking)
- Security Hub's default standards enabled **both** AWS Foundational Security Best Practices and
  CIS AWS Foundations Benchmark v1.2.0 (the latter wasn't explicitly requested — AWS enables it
  by default alongside FSBP). Harmless; disable the CIS subscription later if its findings become
  noise.
- `infra/modules/aws-security-baseline`'s Config aggregator authorization assumes `us-east-1`
  only (single-region aggregation) — revisit if resources start landing in `us-east-2`.
- The forecasted (not actual) monthly spend shown in `aws budgets describe-budgets` was ~$1.21 at
  last check — almost entirely the two KMS CMKs (state bucket + CloudTrail). Nothing alarming
  against the $5 cap, but worth a glance next session.

## Standing guardrail
Nothing gets a "production" designation, and nothing deploys to one, without the user's direct,
explicit sign-off in that session. See [CLAUDE.md](../CLAUDE.md).
