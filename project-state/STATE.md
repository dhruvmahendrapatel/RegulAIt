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
usage_events rows carry `{runId, nodeId}` attribution. Not yet: streaming, multi-turn/system
prompts from workflow context, auto-dispatch of ready nodes (execution is caller-driven per
node), per-user credentials, openai/google/xai adapters.

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
| EPIC-05 | Multi-agent orchestration MVP (PM/Team-Lead/Worker delegation) | **in progress** — slice 1 merged (PR #14: kernel + runs + escalations); slice 2 merged (§5.2 budget caps); worker-node dispatch built (real execution via governed dispatch core, measured budget enforcement) | MULTI_AGENT_ORCHESTRATION_SPEC.md, ADR-0008 |
| EPIC-06 | PM-tool integration MVP (Azure DevOps/Jira/etc.) | **in progress** — slice 1 merged (PR #15); slices 2–4 built (§5 approval mirroring; §4 decision records; ADR-0010 inbound sync with drift detection) | PM_TOOL_INTEGRATION_SPEC.md, ADR-0008, ADR-0010 |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | **applied**, zero drift | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | **applied** (Admin-BreakGlass imported from its manual bootstrap creation, other two created by Terraform) | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | **live and private**: https://github.com/dhruvmahendrapatel/RegulAIt | EPIC-01 |
| COMPONENT-05 | Admin portal | not started | EPIC-02 |
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
