---
phase: governance-mvp-in-progress
last_updated: 2026-07-30
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

**Demo-readiness sweep — the product becomes CLIENT-PRESENTABLE, 2026-07-25.** After the user
tested the deployed stack ("UI looks okay, functionality still looks incomplete"), a 15-agent
audit produced 126 verified gaps with one diagnosis: ~98 REST routes behind eight working
kernels, but the UIs called only 11/22 of them, the seed created no integrations, and nothing
could be *created* from a browser. Seven slices fixed this (commits 94bfb5f, d012f01, 198704e,
plus the fix pass): (1) the seed now populates every object type with real dispatched spend;
(2) credential/key layer — platform + BYO model credentials, one-time API-key reveal, agent-
policy editor, zero raw-UUID inputs; (3) closed approval loop — approver reads, inline
artifact previews, decision reasons, audited admin override; (4) New Run form (canned DAG
templates + advanced JSON), per-node instructions, project create/PATCH, teams; (5) full
pillar-4 write surface — context editor with baseRevision contract, history, promote,
conflict arbitration with both texts; (6) pillar-2 admin home + seeded 10-stage pipeline
(intake→…→sign-off→nested build→checks→branch→mock PR→merge gate→merge) drivable end-to-end;
(7) pillars 5/6/8 in /app — spend page, DAG SVG with elapsed/abort/reassign/escalate, honest
stop reasons, true parallel waves, PM strip + connections tab. The mock provider now returns
intent-shaped tier-differentiated replies (echo bot dead); orchestration routing respects
credential dispatchability. A three-persona headless-Chromium drive (~50 screenshots) and a
fresh-eyes judge returned "demo-ready-with-caveats" with 6 must-fixes — all fixed and
re-verified live (atomic decide + superseded stale approvals, PM mirror upsert + honest sync
+ orphan handling, compact approvals queue with friendly labels, zero console errors on
approver cross-reads, names instead of UUIDs in human-facing strings, self-review guard with
mandatory reason). Suite: 293 → **365 tests**, all green.

**First AWS deployment — the dev demo stack is LIVE, 2026-07-25 (ADR-0013).** The user
explicitly requested an AWS deployment for hands-on testing (cannot run locally); explicit
sign-off obtained in-session via an IAM Identity Center device-code login (Admin-BreakGlass,
workload account). New reusable module `infra/modules/app-instance` (single AL2023 EC2 box,
IMDSv2-only, SSM Session Manager access with NO ssh keypair, pulls a source tarball from a
module-owned private S3 bucket, `docker compose up -d --build` with per-deploy random
runtime config) composed into `infra/environments/regulait-dev-app` — its own state key
(`regulait-dev-app/terraform.tfstate`) so app deploys can never re-plan the org/security
baseline. Applied: instance `i-013c62adc887c76bb`, `http://3.237.199.248:3000` (/app +
/admin verified 200 through the public IP; seed keys handed to the user in-chat, never
committed). Dev-grade by declaration: HTTP only, port open to the world but everything
key-gated, demo data, ~$15–30/mo (will trip the $5 foundation budget alert — expected).
Teardown = `terraform destroy` in `regulait-dev-app`. NOT production; anything beyond demo
use needs a new decision + explicit sign-off. Operational notes: registry.terraform.io is
blocked from the remote dev container — providers install via a filesystem mirror fed from
releases.hashicorp.com (see session log); Terraform runs with the `regulait-admin` SSO
profile, state backend via `regulait-management`.

**The product becomes USABLE, 2026-07-25 — four slices in one push.** (1) Quickstart
plumbing: the gateway converges its schema on boot; `GET /v1/me`; own-scoped list views for
non-admins (runs/instances = own, projects = memberships); an idempotent demo seed driven
through the real HTTP API (three users with keys printed once, seven agents — three mock ones
usable with zero external keys — templates, hipaa profile, budgeted + classified projects, a
planned run, and an instance already awaiting sign-off). (2) `/app`, the end-user workspace:
one dependency-free file on a new shared design system (`ui-theme.ts` — warm dark, terracotta
accent, mono-for-data): a streaming Playground where every exchange shows routing, measured
cost, model, BYO-key, budget alerts, refusals + a collapsible governance trace; Runs with live
node states, per-node outputs, auto-advance, budget bars; Workflows with the stage rail,
artifact submission, and nested-run links; the approver Inbox (all approval kinds, one-click
decide); member Projects with shared context. (3) `/admin` rebuilt on the same system with a
real Cost & Projects dashboard (stat tiles, budget gauge, hand-rolled SVG showback/savings
charts). (4) Docker quickstart: Dockerfile + compose (Postgres + gateway + auto-migrate +
demo seed; keys in the container log) + README for both paths. The whole surface was driven
in a REAL headless-Chromium pass (sign-in, streamed reply, run auto-advanced to completion,
workflow rail, inbox approve, admin charts — zero page errors). (AWS deployment followed
the same day at the user's explicit request — see the entry above / ADR-0013.)

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

**Admin console restructure + roles as a full provisioning bundle, 2026-07-27 (ADR-0014,
migration 0030).** Two gaps closed on user feedback. (1) **Roles now grant agents + connectors**,
not just MCP tools/servers — new `role_agent_grants`/`role_connector_grants` tables (twins of the
per-user grant tables); the kernel folds role-derived grants in additively (`evaluateAgent`
direct-then-role with ceiling/mode still applied; `evaluateConnector` UNION-OF-GRANTS so a narrow
direct grant can't mask a broader role grant), wired into all six evaluate sites; endpoints
POST /v1/roles/:id/grants/{agents,connectors} + four-bucket read-back GET /v1/roles/:id/grants;
per-user revocation of role-derived agent/connector grants deferred (revocations are MCP-only).
ADR-0014 records the additive UNION-MAX semantics. (2) **The portal's flat 13-tab list became 6
grouped sections** (Identity & Access / AI Governance / Policy / Delivery / Cost / Operations); the
overloaded "Users & Roles" tab split into **Users / Roles / Teams**; deep-linking via
`location.hash` (reload keeps the page); the Roles page gained the **role-grants UI** (pick a role →
grant agents/connectors/MCP tools/servers → see the bundle) — the previously-missing "what does
this role grant" surface. UX pass (shared helpers): toast feedback replacing all alert()s +
submit-disable in `wire()`, confirm() on destructive actions, a mobile hamburger drawer (nav no
longer vanishes <900px), `field()` label/aria association, and a contrast bump. Verified on a fresh
DB (build + check-ui-syntax + gateway 297/297 + kernel 82/82) and a Playwright browser drive
(screenshots). Deferred UX follow-ups: table sorting/filter/pagination, human column labels,
raw-JSON operator views, full a11y/contrast sweep.

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
mirrors through a real GET-transitions → POST-transition sequence. **Linear adapter, same day**: GraphQL-only API
handled natively — `LinearProvider` speaks `api.linear.app/graphql` (overridable) with the
raw api-key Authorization header, resolves the connection's `project` as a Linear TEAM KEY to
an id once (cached), and drives `issueCreate`/`issueUpdate`/`commentCreate`/`issue` queries;
GraphQL `errors` arrays surface as explicit PmProviderErrors. Transitions resolve the TEAM's
workflow states by name (explicit failure listing available states); Linear issues carry no
native type, so the interface's `type` is accepted-and-ignored (documented). Default mapping
maps title/description/priority with Linear's default state names; `blocked` unmapped again.
E2e: pm-sync + node_started mirror against a fake Linear GraphQL server (team resolution,
issueCreate inputs, raw-token auth, and the stateId move all asserted). **Asana adapter,
2026-07-25**: `AsanaProvider` speaks the REST API (`app.asana.com/api/1.0`, overridable,
Bearer PAT auth) with Asana's `{data: ...}` envelope on every request/response; `project` is
an Asana project GID and `type` is accepted-and-ignored (no native work-item types). Asana
has no workflow states — `transitionState` resolves the PROJECT's board sections by name
(exact then case-insensitive) and moves the task via `POST /sections/:gid/addTask`, failing
explicit with the available section list; the separate `completed` flag is deliberately
untouched (a section move is the literal board behaviour). `DEFAULT_MAPPINGS.asana` maps
title→name, status→section, description→notes; `priority` AND `blocked` both unmapped (no
native priority field, no default Blocked section — skip, never invent). getWorkItem reads
section-as-state for the matching project membership and filters stories to real comments.
E2e: pm-sync + node_started against a live-shaped fake Asana server (data envelopes, bearer
token, projects array, section lookup + addTask all asserted on the wire). **monday.com
adapter, same day**: GraphQL-only `MondayProvider` (`api.monday.com/v2`, overridable, raw
API token) surfacing HTTP errors, `errors[]`, AND monday's top-level `error_message` as
PmProviderErrors; `project` is a BOARD id, `type` accepted-and-ignored. Item URLs built as
`${boardUrl}/pulses/${id}` from a once-per-board cached board-url lookup. Transitions live
in the board's default Status COLUMN: settings_str labels parsed (cached per board), matched
exact-then-case-insensitive, applied via change_simple_column_value — explicit failure
listing available labels. `DEFAULT_MAPPINGS.monday` maps title→name, status→status with
statusMap in_progress→"Working on it", done→"Done", and — per-provider reality — blocked→
"Stuck" IS mapped (the default label ships); not_started/in_review/description/priority
deliberately unmapped. Registry: azure_devops + jira + linear + asana + monday + mock;
generic_webhook is now the SOLE rejected kind. E2e: pm-sync + node_started against a fake
monday GraphQL server (raw token, board_id/item_name, columns lookup + change_simple_column_
value with "Working on it" all asserted). **Generic webhook adapter, same day — the
pillar-8 matrix is COMPLETE; no provider kind is rejected anymore** (the registry switch
stays exhaustive so a future kind still forces a compile error). `GenericWebhookProvider`
inverts the vendor pattern: it POSTs RegulAIt's OWN normalized envelope `{event, timestamp,
project, payload}` (work_item.create/update/transition, comment.add, work_item.get — the
outbound mirror of ADR-0010's inbound shape) to a single customer-defined baseUrl (required,
used verbatim). The connection token is a shared secret used ONLY for signing —
`x-regulait-signature: sha256=<hex HMAC-SHA256 of the exact body>`; the token never travels.
Receiver contract: 2xx or explicit provider error; create must return a real {id, url}
(missing id fails explicit, links are never invented); work_item.get returns the item so
Sync-now verification works, and receivers without read-back fail loudly into the existing
orphan flow. `DEFAULT_MAPPINGS.generic_webhook` is the IDENTITY map over all five canonical
states including blocked — nothing invented because the vocabulary is ours. E2e: the fake
receiver verifies the HMAC on every request and asserts the token never travels raw.
**Compliance enforcement — PII mode + audit-retention pruning, 2026-07-26 (pillar 3 polish
1/4; no migration).** The cascade's last two "declared-not-enforced" dimensions become real.
New pure `packages/shared/src/pii.ts` `detectPII` (email / bounded SSN / Luhn-validated CC /
US phone — returns per-category COUNTS ONLY, never the matched substring, §8.4-safe). Wired
into the two PROJECT-ATTRIBUTED dispatch paths (executeGovernedDispatch + connector invoke;
MCP path honestly DEFERRED — it has no projectId): block on INPUT denies pre-call (no cost,
effect deny ruleId pii-blocked); block on OUTPUT bills-and-withholds (usage row written for
honest spend, outputText replaced by a withheld marker); warn proceeds + piiWarning + audit
pii-warned; log records category counts only. No-classification project = byte-identical
no-op. Audit-retention pruner: POST /v1/audit/prune (admin) deletes audit_log rows older than
a GLOBAL floor = max auditRetentionDays across all compliance profiles (longest-floor-wins,
audit_log has no projectId) + GET /v1/audit/retention shows the floor; the /compliance labels
honestly flipped (only claiming model+connector PII, mcp deferred). Suite 552 → 577.
Independently re-verified: build clean, shared pii 17/17, gateway pii e2e + mcp-proxy 158/158.
KNOWN LIMIT: streaming output-block can transiently flash raw text before the result event
overwrites with the withheld marker (input-block — the common vector — is airtight pre-call);
fast-follow = suppress streaming for block-mode projects.

**Pillar 3/4/5 polish batch complete, 2026-07-26 (4 slices, all stacked on PR #29).** Slice 1 =
the compliance-enforcement block just above (PII mode + audit-retention pruning, no migration).
Slice 2 (pillar-4 membership lifecycle, NO migration): PATCH/DELETE project members, owner-gated,
with hard last-owner protection (409); a provenance fix (context authorship now requires a real
authenticated user — bootstrap token 403s instead of being mis-attributed) and a write-race fix
(writeContextRevision read+insert wrapped in a transaction, 23505 caught+retried against the
existing (project,key,revision) unique index). Slice 3 (pillar-5 cost depth, migration 0028):
projects gain budget_period (none|monthly) + alert_threshold_pct + overage_approved_period —
calendar-month (UTC) windowed spend, overage latch scoped to the approved period key (clears on
rollover), non-blocking threshold alert below cap + hard block at 100%, CSV export
(/costs.csv + /usage-events?format=csv, RFC-4180, member-authz). Slice 4 (pillar-5 Initiative
object + cross-team rollups, migration 0029): new `initiatives` table — a FLAT, REPORTING-ONLY
grouping of projects (NOT a governance tier; no initiative-level budget/enforcement in v1) — plus
a nullable `projects.initiative_id` FK (onDelete set null: deleting an initiative orphans children
back to ungrouped, never deletes project rows). Admin-only CRUD /v1/initiatives (deliberately NOT
in NON_ADMIN_ROUTES — a rollup spans projects a non-admin may not be a member of), rolling up
child count + spend. /v1/projects/:id/costs gains a `byTeam` breakdown (spend attributed to the
team each member contributes under IN THIS project via project_members.teamId; null = "(no team)",
never fabricated) and the project's parent `initiative` label (so the member /app can show it
without the admin endpoint). Per-workflow cost_events source documented-as-reserved (comment,
no writer). Suite 552 → 597 across the batch. Each slice independently re-verified on a fresh DB
(build + check-ui-syntax + the relevant security-critical suites); slice 4 final: gateway 284/284
+ policy-kernel 71 + optimizer 31 + orchestration 23 + shared green. CI on PR #29 is
billing-cap-blocked (account-level Actions minutes cap: both jobs instant-fail, 404 logs, empty
output — verified not code); local verification is the gate. The AWS dev stack is on the
pre-polish merged-main build; a redeploy would be needed after PR #29 merges (only on request).

**§8.2 infrastructure-operations layer, 2026-07-26 — pillar 3's last unstarted surface lands
as a GOVERNED-operations layer (migration 0027).** Monitored resources + operational policies
+ inert findings + governed remediation — not a real patcher; a keyless MockInfraProvider
demos the whole detect→propose→approve→remediate spectrum. Migration 0027: infra_resources
(kind control_plane|agent_runtime|cert|backup_target, classifications), infra_policies
(patch cadence, cert-rotation window, backup schedule+retention, drift baseline,
auto_remediate_max_severity — enum low|medium|high, can't hold 'critical'), infra_findings
(drift|cve|cert_expiring|backup_missed × low|medium|high|critical, status open|
remediation_proposed|auto_remediated|remediated|accepted_risk; UNIQUE on
(resource,kind,detail.signature) so re-scan is idempotent); + approvals/audit_log objectType
+= 'infra_operation'; + compliance_profiles gains backup_retention_days + patch_cadence_days.
New packages/infra-provider mirrors connector-provider (scan/remediate interface, mock keyless
+ aws/azure/gcp 501). THE INVARIANT: a finding is an inert report; a remediation is governed.
On scan a finding is AUTO-remediated (no approval, still AUDITED ruleId infra-auto-remediate)
iff policy has an auto ceiling AND severity ≤ ceiling AND severity !== 'critical'; everything
else + ALL critical findings are approval-gated (approvals row objectType infra_operation via
__infra_remediation__ sentinel → the shared /decide txn → applyInfraApprovalDecision calls
provider.remediate on approve / accepted_risk on deny, both audited, all SoD guards for free).
Critical is doubly guarded (ceiling can't be 'critical' + explicit !=='critical'). §8.3
FINALLY ENFORCED: effectiveCompliancePolicy now composes backupRetentionDays (max) +
patchCadenceDays (min); a classified resource's backup floor = max(policy, cascade.backup,
cascade.auditRetentionDays) — consuming the formerly-dead auditRetentionDays — and its patch
ceiling = min(policy, cascade.patch); the /compliance endpoint's "declared-not-enforced"
labels honestly narrowed to only the still-unenforced parts. Admin Operations tab (resources/
policies/scan-now/findings-inbox/posture); app-ui infra approval label; seed 5 resources (one
HIPAA) + a scan producing the auto/open/critical mix. Suite 535 → 552 (10 provider unit + 7
e2e). Independently re-verified: build clean, infra-provider 10/10, infra e2e + mcp-proxy
157/157 (shared decide path regression-free).

**Pillar-1 rule scoping, 2026-07-26 — policy rules gain role/team/fleet scope (migration
0026); the "one row per user per server" gap closed.** All three restriction-rule tables
(approval_rules, rate_limits, data_scope_rules) were hard-bound to one user × one server
(NOT NULL FKs) — a fleet-wide "any write requires approval" was inexpressible. Migration 0026
(identical per table): user_id/server_id → nullable; add role_id/team_id (nullable FKs),
scope ('user'|'role'|'team'|'fleet', default 'user') + server_scope ('server'|'all', default
'server'); raw CHECK constraints enforce the discriminant; existing rows backfill to
scope='user'/server_scope='server' — byte-identical behaviour (all pre-existing single-user
rule tests pass unchanged). The gateway pre-filters rules in SQL by scope-membership —
`(fleet OR user=me OR role∈myRoles OR team∈myTeams) AND (all-servers OR server=this)`
(loadScopeMemberships resolves roleIds+teamIds) — exactly as role GRANTS are already
pre-filtered, keeping the kernel subject-free. THE INVARIANT (proven): all three rule types
run ONLY AFTER the untouched grant check, so a scoped rule can only ADD a deny/require_approval/
cap — it can never move default-deny to allow, and never relax another scope. Most-restrictive-
wins with NO cross-scope override (no exemptions in v1 — that would widen; deferred as a
separate explicit object): data-scope intersects all matching rules, rate-limits keep
independent per-subject counts (tightest denies first, no summing; all-servers rules count
across servers), approval pauses on any scope match. Guard test: a fleet/role restriction
never rescues an ungranted call. Admin Policy & Rules tab gains scope + server-scope selectors
with a swapping target select and legible "fleet"/"role: X"/"team: Y"/"all servers" listing;
seed shows a fleet approval rule + a role-scoped rate limit. Suite 524 → 535 (6 kernel unit +
5 e2e incl. the headline "fleet rule reaches a user with NO user-specific rule"). Independently
re-verified: build clean, policy-kernel 71/71, mcp-proxy 150/150.

**Connector execution layer, 2026-07-26 — pillar 5's connector-cost gap closed (migration
0025).** POST /v1/connectors/:id/invoke now really contacts the target system and meters cost.
New package `packages/connector-provider` mirrors pm-provider: CONNECTOR_PROVIDER_KINDS
(http/webhook/slack/github/jira/snowflake/generic/mock) + isConnectorProviderKind, neutral
`ConnectorProvider.invoke({operation,object?,payload?})→{status,body}`, injectable FetchLike,
GenericHttpConnectorProvider (read→GET, write→POST payload, optional bearer) + Webhook +
keyless MockConnectorProvider; registry exhaustive-switch, mock keyless, generic/http/webhook
need baseUrl, slack/github/jira/snowflake throw 501 (no silent promises). THE INVARIANT: one
allowed call = the existing ONE audit row + exactly ONE usage_events row; denied → 403 no bill,
failed upstream → 502 no bill (mirrors model path); execute+meter strictly inside the allow
branch. Flat pricing: pricePerCallUsd (null = unpriced → null cost, never invented). BACK-COMPAT:
a connector with null providerKind keeps today's governance-only behaviour exactly (decision +
audit, no execution, no cost) — nothing breaks until a connector opts in. Migration 0025:
connectors +provider_kind/base_url/price_per_call_usd (kind stays the free-text CATEGORY); new
connector_credentials (AES-256-GCM, platform-scoped, never returned); UNIFIED LEDGER —
usage_events token/model NOT NULLs relaxed + object_type ('agent' default, backfilled) +
connector_id + operation, so connector spend rides the SAME ledger and the project total +
showback-by-member pick it up automatically. Rollup gains byConnector (byAgent filtered to
object_type='agent', no phantoms); Spend page + per-project drill-down get a "Spend by connector"
card. Seed: snowflake-analytics now mock-kind $0.002/call (executes keyless) + 3 attributed
reads, jira-cloud stays governance-only. Suite 508 → 524 (8 provider unit + 8 e2e).
Independently re-verified: build clean, mcp-proxy 145/145, all 8 connector-execution e2e green,
migration applies on boot. Every governed entry point — model dispatch, MCP tool, connector —
now flows through the one attribution point.

**Team-Lead entitlement-narrowing tier, 2026-07-26 — pillar 7 §5.1 lands; pillar 7 complete
(no migration).** Worker nodes can declare a `leadNodeId` + `allowedAgentIds`/`allowedToolRefs`
delegation subset (ride the graph jsonb like the tool fields). The pure kernel helper
`computeNodeCeiling(graph, nodeId)` walks the lead chain UP and INTERSECTS each ancestor's
allow-sets (null = no constraint at that hop = identity; set∩set; empty = nothing) → a node's
transitive ceiling. policy-kernel: evaluateAgent gains ceilingAgentIds (new rule
`agent-lead-ceiling`), evaluate gains ceilingTools (new rule `lead-ceiling`) — consulted ONLY
on the allow path, so a ceiling can turn an allow into a deny but NEVER rescue an ungranted
call; default-deny preserved; a null ceiling adds no trace entry (flat runs byte-identical).
The INVARIANT (proven, not relabeled): effective = user_grants ∩ lead_chain_ceiling, composing
grandchild ≤ child ≤ lead ≤ initiating user — a worker is denied a tool/agent its INITIATING
USER genuinely holds because a lead excludes it, while a lead-less control node uses it fine.
Grants subject stays run.initiatingUserId at every site; the ceiling is a SEPARATE arg threaded
into evaluateNodeOwner (dispatch + reassign), planRun evalOwner (envelope + budget re-plan
candidate filter — a re-plan won't move a node onto a ceiling-forbidden agent), resolveNode
ToolContext (narrows what the model is even offered), and per-call executeGovernedToolCall (hard
enforcement). Distinct audit ruleId separates "narrowed by lead" from "user not granted" with
zero new logging. Decompose planner drafts optional two-level hierarchies (lead suggests subset,
gateway drops+records anything beyond the caller's own grants, human edits — the New Run editor
gained a per-node Lead select + allowed-agents/tools controls + indented hierarchy render);
mock `<<lead-plan>>` sentinel for keyless demo. Suite 485 → 508 (9 kernel unit + others).
Independently re-verified: build clean, policy-kernel 65/65, orchestration-tools e2e 9/9
including the narrowing cases. **Pillar 7 is now complete** — agents plan (decompose), do
tool-using work (governed loop), and delegate under enforced transitive entitlement ceilings.

**Tool-using multi-turn workers, 2026-07-26 — pillar 7's workers become a governed agentic
loop (no migration).** dispatchRunNode's single model call is now a bounded loop: each turn
one governed dispatch (measured usage row billed to run.projectId) with `tools` + accumulated
tool-history messages; when the model returns stopReason "tool_use", each tool call runs
through the SAME governance path as the MCP proxy — extracted as `executeGovernedToolCall`
(mcp-proxy.ts) and invoked AS run.initiatingUserId, one audit row each, so allow-list/
data-scope/rate-limit/approval self-enforce MID-LOOP across turns (rate limits are audit-log-
derived, so the Nth call is counted for free). Bounded by BOTH node.maxTurns (default 6, cap
20) AND the per-run measured budget checked EVERY turn — a runaway loop halts and escalates a
__budget__ approval into the one queue exactly like a single dispatch; an approval_required
tool breaks the loop leaving the node blocked, never hangs; no privilege increase entering
the loop. Provider contract extended additively (ModelToolDef in, "tool_use" stopReason +
toolCalls out, ModelChatMessage.content widened to text/tool_use/tool_result blocks; byte-
identical when tools absent) — Anthropic + OpenAI-family fully wired, Google best-effort. Mock
gains `<<use-tool:NAME>>` / `<<use-tool-loop:NAME>>` sentinels so the loop is testable keyless
against the real-upstream MCP harness. Node declares toolServers/toolNames/maxTurns in the
graph jsonb (kernel schema extended — NO migration; per-turn/tool trace rides the event jsonb
as node_tool_call). Decompose planning prompt lists the caller's entitled servers+tools so the
lead can assign them; New Run editor gains per-node tool-servers + max-turns controls. Suite
473 → 485 (7 unit + 5 e2e over the real upstream: granted-loop, ungranted-deny-mid-loop,
maxTurns cap, rate-limit-mid-loop, per-turn-budget halt+escalate). Independently re-verified:
build clean, mcp-proxy 137/137 green after the extraction. Deferred (unchanged): Team-Lead
TIER with transitive entitlement narrowing.

**Automatic context compaction, 2026-07-26 — pillar 6 §5 lands (first technique enabled by
the messages array).** Pure decision in optimizer-kernel (planCompaction/compactionSavings;
threshold >1600 est. tokens of model-bound history, last 4 messages always verbatim;
constants — per-user dials deferred pending an agent-policy migration home). Migration 0024:
summary/summary_through_message_id/summary_tokens/compacted_at on conversations — stored
messages NEVER deleted or altered (asserted). The summarizer is one governed dispatch to
the caller's cheapest entitled+dispatchable agent (audit purpose:"compact", billed to the
same project — the visible price of the savings); re-compaction is CUMULATIVE (prior
summary + newer turns, compacted-away turns never re-read); failure fails OPEN (audited
context-compaction-failed-open, full history dispatches, turn succeeds, failOpen in trace);
routingMode "passthrough" disables it (§12 off-switch consistency). Savings = max(0,
omitted − summary) tokens at the served agent's input price, recorded per summary-riding
dispatch under technique context_compaction in the SAME detail shape as model_routing — the
Spend page and admin charts lit up with zero chart changes. /app shows a compaction divider
with the expandable stored summary + badges + trace detail, persisted on replayed threads.
Suite 455 → 473; browser-verified (on-topic continuation through the summary, $0.0044
compaction bar beside model_routing, zero console errors).

**Prompt caching, 2026-07-27 — pillar 6's 4th technique (after routing, compaction, lazy
tool-loading).** NO migration — the `prompt_caching` cost_events enum value already existed.
Pure `planPromptCache` (optimizer-kernel): marks a stable system prefix cacheable once it clears
Anthropic's 1024-token minimum; passthrough is the §12 off switch; estimatedTokensSaved = the full
prefix served from cache per reuse; CACHE_READ_DISCOUNT 0.9 (ephemeral read ≈ 0.1× list, with the
first-call ~1.25× write surcharge acknowledged — the estimate is the labeled STEADY-STATE reuse
saving). model-provider gains an optional `cacheSystem` on the dispatch request: the Anthropic
adapter emits `system` as a text block carrying `cache_control:{type:ephemeral}` when set (plain
string otherwise, byte-identical); OpenAI/xAI/Google are documented no-ops (auto-cache / no
explicit breakpoint). Gateway writes ONE `prompt_caching` cost_events estimate when caching applies
and threads `cacheSystem` through the dispatch path — a pure cost annotation that never changes the
served agent/model/entitlement/budget/output (§12). The cacheable prefix is sourced from a new
optional `system` field on the invoke request body (the `agents` table has no system-prompt column
yet — a stored `agents.systemPrompt` column is the natural future home, deferred to avoid a
migration this slice). Suite 284 → 288 (prompt-caching.test.ts); optimizer 31 → 36, model-provider
57 → 60. No UI change (savings-by-technique chart is technique-generic). Remaining pillar-6
techniques: edit-vs-rewrite, file pre-processing, semantic caching, request batching.

**Edit-vs-rewrite, 2026-07-27 — pillar 6's 5th technique.** NO migration (the `edit_vs_rewrite`
cost_events enum value already existed). Pure kernel: `classifyEditIntent` (edit / rewrite /
unknown keyword heuristic — a REWRITE signal WINS when both appear, so a full rewrite is the safe
non-optimizing default and we never diff on an ambiguous ask) + `planEditVsRewrite` (guard order
mirrors planPromptCache: passthrough → no baseline → non-edit intent → baseline below the
200-token floor → else edit). When the request reads as a targeted edit over a large-enough
baseline, the gateway injects a compact-diff directive into the dispatch `system` and the
caller-supplied baseline (delimited) into the dispatch `input`, so the model returns a small diff
instead of re-emitting the whole file — the OUTPUT saving is real (not just accounting), the same
way prompt caching actually emits `cache_control`. Opt-in via a new `baseline` field on the invoke
body; baseline tokens are folded into the routing estimate BEFORE routeModel (the model must see
the file either way, so routing/budget/cost reflect the real payload); one `edit_vs_rewrite`
cost_events estimate is written, priced at the served agent's OUTPUT list price (saving ≈ baseline
× 0.75 output tokens). Pure cost annotation — never changes the served agent/model/entitlement/
budget/output; passthrough is the off switch. The baseline rides the model input for that one
dispatch only — persisted conversation history keeps the original request, so it never bloats or
re-sends. Suite 288 → 292 (edit-rewrite.test.ts); optimizer 36 → 47. No UI change. Remaining
pillar-6 techniques: file pre-processing, semantic caching, request batching.

**File preprocessing, 2026-07-27 — pillar 6's 6th technique.** NO migration (enum value existed).
Pure `preprocessReference` deterministically shrinks attached reference/file content without
changing meaning (collapse whitespace runs, trim, collapse 3+ blank lines, elide >512-char
base64/data blobs) while PRESERVING fenced code blocks verbatim (idempotent). `planFilePreprocessing`
decides whether to apply (passthrough off-switch; below a 200-token floor or a zero-reduction result
left untouched) and estimates INPUT tokens saved. Gateway: opt-in `referenceContent` invoke field;
reference tokens folded into the routing estimate at the ACTUAL sent size; processed content appended
as a delimited REFERENCE block (coexists with edit-vs-rewrite's baseline in the shared dispatchInput
composition); one file_preprocessing cost_events estimate at the served input price; persistTurns
keeps the original turn so the reference never bloats history. Suite 297 → 302; optimizer 47 → 59.
Remaining pillar-6: semantic caching + request batching (next slice, migration 0031).

**Semantic caching + request batching, 2026-07-27 — pillar 6's 7th & final techniques (migration
0031).** Semantic caching is a REAL opt-in per-(user,agent) exact-match response cache: an
identical (whitespace/case-normalized) single-turn re-ask within a 1h TTL is served straight from
the `semantic_cache` table, skipping the provider entirely — no usage_events, one `semantic_caching`
cost_events row for the whole-call saving. The lookup runs INSIDE the governance allow-gate and is
scoped by BOTH userId AND agentId (with a normalizedInput collision guard), so a user is never served
another user's — or another agent's — cached response (§12); misses store the result (refreshing the
TTL, never caching refusals/empty/PII-withheld). Request batching is an ESTIMATE only: on an
orchestration auto-pass with ≥2 ready nodes on the same model, one `request_batching` cost_events row
books the per-request overhead batching would amortize — dispatch is unchanged (true async
Batches-API batching doesn't fit the synchronous interactive path). Suite 302 → 307; optimizer 59 →
69. **All seven pillar-6 optimization techniques now shipped**: model routing, context compaction,
lazy tool-loading, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching (+ the
request-batching estimator).

**Admin console UX polish, 2026-07-27.** The deferred follow-ups from the console restructure:
`dataTable()` with free-text filter + keyboard-operable sortable headers (aria-sort, numeric-aware)
+ pagination (adopted on Users/Audit/Approvals/Projects/Findings); `humanizeKey` so th labels read
"Cost Center"/"Alert %" not camelCase; raw-JSON operator views replaced with formatted UI
(Simulation decision = effect badge + numbered rule chain, Compliance = badges + kv list, Infra
posture = inline counts, each with raw behind a `<details>`); and an a11y pass (focus-after-render on
the panel h1, nav aria-current, sortable-th keyboard, text badges for status not color-only, contrast
bump). Browser-verified (filter/sort/paginate on Audit, humanized headers, no console errors beyond
pre-auth 401s). This closes the "review the whole UI/UX" thread except the intentionally-open items
(nothing further deferred beyond what the deeper-a11y sweep would add).

**Pillar 7 — Team-Lead transitive per-node budget ceiling, 2026-07-30 (session-02 addendum 31, ADR-0016).** A mapping pass found the AGENT-entitlement narrowing already shipped (§5.1 lead ceiling: allowedAgentIds/toolRefs → computeNodeCeiling transitive intersection → policy kernel agent-lead-ceiling), so this slice built the missing BUDGET half. A task node gains `budgetCapUsd`; `computeNodeBudgetCeiling` folds the MIN of the node's own cap and every lead ancestor's — symmetric with the agent ceiling (delegation only ever TIGHTENS). Enforced at node_started on top of the run cap: a node over its ceiling escalates into the one Approvals Queue (node-budget-cap). No migration. Gateway 332 → 336, orchestration-kernel 23 → 27. Remaining in the sequence: pillar 3 infra-ops automation.

**AWS redeploy of PRs #34–#37 + a Docker-build fix + CI paused, 2026-07-30 (session-02 addendum
32, PR #38 merged).** The user asked to redeploy the merged work (chat multimodal, pillar-2
deploy/verify/rollback, pillar-3 BYOC, pillar-7 sub-budget) to the dev stack and to stop burning
CI. The redeploy SURFACED a real break: merged `main` did not build in Docker, because the image
runs `pnpm -r build` which type-checks the test files too (each package tsconfig `include:["src"]`)
and two test files that shipped via merged PRs carried type errors CI never caught — the account's
GitHub Actions minutes are exhausted, so every run instant-fails on a 404 log download before the
build gate ever runs. Fixed both (`model-provider/index.test.ts`: two block-array `dispatch()`
calls omitted the required-but-ignored `input` field + a null-narrow; `gateway/node-budget.test.ts`:
two inject helpers returned `app.inject(...)` un-awaited, yielding the overload-intersection type
without `.statusCode`/`.json` — awaited inside, matching sibling helpers). **CI paused** —
`.github/workflows/ci.yml` triggers switched to `workflow_dispatch` only (the `pull_request`/`push`
triggers kept commented for a one-line revert once minutes top up); local verification
(`pnpm -r build` + `check-ui-syntax` + `pnpm -r test`) is the gate meanwhile. PR #38 carries both
and is MERGED — `main` builds again. The dev stack was redeployed from the branch HEAD (= `main` +
those two commits, byte-identical app to post-merge main) because `main` itself didn't build until
#38 merged: `docker compose up -d --build` on `i-013c62adc887c76bb`, gateway container recreated,
the Postgres volume (pgdata) + per-boot secrets override preserved, migrations 0030–0033 applied
(`deploy_targets` present), `/app` + `/admin` 200 on-box at `http://3.237.199.248:3000`. Still
dev-grade, NOT production. The user then directed the four remaining open-item areas in parallel:
pillar-3 infra-ops AUTOMATION (drift/CVE/cert/backup — the operational half beyond the §8.2
governed-ops layer), clearing the ADR-0015/0016 + pillar-2 deferrals, and a deeper UX/a11y pass.

**Four-area cleanup batch shipped, 2026-07-30 (session-02 addendum 33; migrations 0034 + 0035;
ADR-0017, ADR-0018 + ADR-0015/0016 addenda; PRs #40/#41/#42, all merged).** The four directed
areas landed as three per-chunk PRs on fresh branches (branch-per-PR adopted this session so the
mobile app's PR chip tracks the current PR, not an old merged one). **(1) Pillar-3 infra-ops
automation (migration 0034, ADR-0017):** automation DEPTH on the existing §8.2 detect→remediate
spine — durable domain ledgers (`cert_inventory` + `cert_rotations`, `patch_records`
UNIQUE(resource,cve), `backup_runs`) that hang off `infra_resources` and link back to the inert
`infra_findings` via `ref_table`/`ref_id`; the pure detection math (`compareDrift`,
`cvssToSeverity`, `certSeverity`, `evaluateBackupSchedule`) extracted + unit-tested; governed
operator verbs (rotate / patch / restore) that flow through the ONE Approvals Queue via an
action-tagged sentinel `__infra_action__:<action>:<id>` — approve runs the provider action + writes
the ledger outcome in the same /decide txn, deny → linked finding `accepted_risk`; air-gapped
resources reuse the ADR-0015 boundary (metadata-only). `infra_resources.deploy_target_id` ties
customer-hosted resources to their BYOC target. No live cloud mutation. **(2) Deferral cleanup
(migration 0035, ADR-0018 + addenda):** azure/gcp/kubernetes deploy adapter SHAPES (dry-run + //
REAL: markers; all five kinds resolve); real @aws-sdk STS AssumeRole behind an off-by-default
`REGULAIT_DEPLOY_LIVE` flag (injectable client, fake in tests, no live mutation); admin Deploy
Targets management UI; MEASURED per-node budget running total (`measuredPerNodeUsd`,
`__nodebudget_measured__` escalation) + decompose auto-suggesting per-node caps + a per-node cap
chip in /app — clearing all three ADR-0016 deferrals; assignment matching gained target-system +
initiator-role dims (3→5 of 6 wired; data-sensitivity still deferred; `initiatorRole` server-
resolved, never client-supplied); seed now drives instances to rest at blocked_on_check /
blocked_on_deploy / rolled_back. A4 (per-mode policy + mode-aware audit retention) recorded as
design-only in the ADR-0015 addendum. **(3) Deeper UX/a11y:** shared render helpers hoisted into
`ui-theme.ts` (`UI_TABLE_JS`) so both UIs + every table reuse them; `table()` delegates to
`dataTable()` above 8 rows (the new Deploy Targets + infra cards inherit sort/filter/paginate free);
/app parity (renderDecision for the Playground trace, aria-live toast region, heading focus, mobile
hamburger, idChip sweep); a real WCAG contrast fix (`--text-faint` ~3.3:1 → ~4.9:1 + a `--decor`
token) + global :focus-visible rings + keyboard-copyable idChips. Verified per PR on a fresh DB
(build + check-ui-syntax + suites) — full gateway suite 345 → 361; UX PR added a headless-Chromium
drive (0 console errors, axe color-contrast serious+ = 0). CI stays paused; local verification was
the gate. Deploy note: also caught + fixed a pre-existing main build break (two test-file type
errors CI never saw while Actions minutes are exhausted) as part of the redeploy — see addendum 32.

**Pillar 3 — BYOC deploy targets: modes + AWS assume-role adapter + data boundary, 2026-07-28
(session-02 addendum 30, migration 0033, ADR-0015).** First pillar-3 slice, extending the pillar-2
deploy tail into customer-owned cloud. A deploy target gains a `mode` (hosted / byoc / air_gapped)
plus, for AWS BYOC, a `roleArn` + `region`. The `AwsDeployProvider` models STS AssumeRole into the
customer's role (short-lived creds, no static key) then deploy in their region — execution is a
deterministic **dry-run** (no real cloud call, no prod resource without explicit sign-off; `// REAL:`
markers show where the @aws-sdk calls go). The disclosed control-plane / agent-execution-plane data
boundary is **enforced in the executor by mode**: air_gapped keeps METADATA ONLY in the control
plane (never the deploy URL / provider detail), hosted/byoc keep the full record — a testable
property (air-gapped e2e asserts nothing crosses back), not prose. Gateway 327 → 332. Deferred: real
@aws-sdk execution, azure/gcp/k8s adapters, admin mode UI (ADR-0015).

**Pillar 2 — deploy → verify → auto-rollback, 2026-07-28 (session-02 addendum 29, migration
0032).** Completes the workflow pipeline's tail, on top of the check fail→route primitive. The
kernel gains executable `deployment` + `rollback` stages, a `blocked_on_deploy` manual-handoff
state, and a terminal `rolled_back`. A post-deploy verify is an `automated_check` with
`onFailure:"rollback"` that routes STRAIGHT to its rollback stage on failure (auto self-heal);
a rollback stage is a failure-only jump target that normal flow skips, so a passing deploy never
reverses itself. The deploy executor gates on a configured deploy target existing AND an optional
condition matching the change — either unmet parks at the manual handoff (resolved via
`POST .../deploy-override`); otherwise it deploys via a provider-agnostic adapter (mock now;
cloud adapters declared-not-integrated). Deploy targets are a new governed admin resource
(`deploy_targets`, creds encrypted at rest). The /app workflow detail surfaces the handoff, the
rolled_back terminal, and a Delivery row (live / rolled back). Gateway 322 → 327, kernel 29 → 33.
Next in the pillar sequence: pillar 3 BYOC/air-gapped deploy (real cloud adapters), pillar 7
orchestration depth, pillar 3 infra-ops.

**Pillar 2 — automated checks that FAIL and route, 2026-07-28 (session-02 addendum 28).** First
"workflow depth" slice after the 3-ask batch. Before this, every named automated_check auto-passed
— the pipeline had no failure path at all. Now a REPORTED failing check parks the instance at a new
`blocked_on_check` state (kernel: `check_failed`/`recheck` events + surfacing effect, guarded)
instead of advancing; a remediate-then-recheck loop resumes it. The gateway check executor resolves
each named check from reported results (`POST .../checks` — a real CI posts them, seed/tests too),
falling back to the deterministic auto-pass when none are reported (existing templates byte-
identical); a failure is audited `workflow:check_failed`. `POST .../recheck` re-runs a parked stage.
The /app workflow detail surfaces the block, per-check severity, "mark passing", and "Re-run checks".
No migration (free-text status; results in JSONB context). Gateway 318 → 322, kernel 26 → 29. This
is the failure primitive the conditional deploy + post-deploy rollback stages (next slice) build on.

**Chat→Claude + visual context graph + multimodal attachments, 2026-07-28 (three prioritized
product asks, see session-02 addendum 27).** (1) **Chat routes to Claude**: a platform API-key
ENV fallback (ANTHROPIC_API_KEY etc., last-resort after stored user/platform creds, read at
dispatch only) lets a self-hosted box go live with no admin-UI paste; a read-only
`GET /v1/model-providers/status` (booleans only) drives the composer's not-configured banner, and
a fresh chat now defaults to the highest-tier live non-mock agent (Claude wins ties). (2)
**Visual Context Graph** (pillar 4): new /app page rendering the shared-context store as a
dependency-free SVG version graph — one column per key, baseRevision→revision lineage edges,
conflict forks amber/dashed, click-for-detail with contributor/team provenance; backed by
`GET /v1/projects/:projectId/context/graph` (viewer-gated, 240-char preview). (3) **Multimodal
attachments** (mimics Claude native): 📎 + drag-drop + paste-image composer with a thumbnail/chip
tray (<= 8 files, <= 6 MB each) — images/PDFs ride the dispatch as base64 `attachments`
(`ModelContentBlock` gained image/document variants; Anthropic maps to native source blocks,
other adapters degrade to a named placeholder), text/code files ride `referenceContent`; history
stores only a named marker (never bytes, never re-billed), and attachments never widen
entitlement. Suite 307 → 318 (attachments.test.ts); model-provider 60 → 62. Browser-verified both
new surfaces, zero console errors.

**Agent-driven task decomposition, 2026-07-26 — pillar 7's headline lands, human-gated.**
`POST /v1/runs/decompose` {goal, projectId?, leadAgentId?}: a Team-Lead agent (leadAgentId ??
user default ?? cheapest granted mock, entitlement-checked under mode "plan") drafts a
task-graph PROPOSAL via one governed metered dispatch (policy → project budget gate →
usage/audit with detail.purpose:"decompose"; roster in the prompt = the caller's entitled
AND dispatchable agents with tier/price so suggestions are grounded). Parse (balanced-JSON,
fence-tolerant) → decompositionPlanSchema (2-8 kebab-id nodes) → agent names resolved
against real grants (unknown → default agent with recorded substitution) → the SAME kernel
validateGraph as planRun; one error-fed retry then honest 422 with rawOutput (both attempts
billed). It never creates a run — the proposal lands in the New Run editor (editable
everything, substitution badges, lead cost banner, "nothing runs until you accept") and
acceptance is the unchanged human plan gate. Mock planner: deterministic 4-node
analyze → two parallel goal-keyword middles → integrate, roster-aware, tier-scaled —
demoable with zero external keys. Suite 443 → 455; browser-verified (drafted plan executed
to completion with ∥ badges, zero console errors). Deferred (unchanged): Team-Lead TIER
with transitive entitlement narrowing, tool-using multi-turn workers.

**Multi-turn conversations, 2026-07-25 — the Playground stops being amnesiac (pillar 6
prerequisite unlocked).** `ModelDispatchRequest.messages` (full ordered history; `input`
ignored when present, byte-identical single-turn otherwise) threaded through all five
providers (google maps assistant→"model"; mock opens with a continuation line and terse
follow-ups inherit the previous turn's topic — demo-provable). Migration 0023:
`conversations` + `conversation_messages` (FK-free subject ids like the ledgers, cascade on
messages, assistant detail jsonb = stopReason/refusal/servedAgentId/modelUsed/costUsd/
credentialSource). Invoke accepts `conversationId`: ownership checked before anything bills;
EVERY turn is the unchanged governed pipeline (policy → routing → budget → audit → ledgers,
history growth added to cost estimates so budget gates stay truthful); transactional
persistence — success both turns, refusal flagged, denial user-turn-only (excluded from
future model-bound history), dispatch failure nothing. Own-scoped CRUD. /app Playground is
now two-pane: conversations rail (new/delete/active restore via sessionStorage), history
replayed through the SAME badge renderers as live turns (incl. denial pills), auto-create +
auto-title on first send, mid-thread agent/project switching. Seeded 2-exchange demo
conversation (idempotent, real-API-driven) + new seed.test.ts double-run suite. Suite
416 → 443. Browser-verified: continuation reply on-topic, reload restores thread, zero
console errors.

**Provider-native inbound webhooks, 2026-07-25 — the deferred ADR-0010 depth item.** New
`packages/pm-provider/src/inbound.ts`: per-provider `parseInboundWebhook` (exhaustive
registry) verifying each tool's REAL mechanism and translating its REAL payloads into the
one existing normalized shape — handshakes answered without processing, valid-but-irrelevant
payloads 200-and-dropped, verification failures → 401 with no secret material. Mechanisms:
linear `linear-signature` HMAC; asana two-phase (`x-hook-secret` echo handshake, then
`x-hook-signature` HMAC over thin state-less events resolved by read-through); monday
`{challenge}` echo + URL-token (monday sends no signature — documented limitation); jira
URL-token (Jira Cloud manual webhooks can't sign or set headers); azure_devops basic-auth
password; generic/mock `x-regulait-signature` HMAC (outbound symmetry) with the legacy
secret header still accepted, signature taking precedence. All comparisons constant-time.
Migration 0021 adds `pm_connections.webhook_secret_ciphertext` (AES-256-GCM, same envelope
as tokens) because HMAC needs the secret itself — the sha256 hash stays and still gates
legacy traffic. Raw-body capture is scoped to the webhook route only (encapsulated Fastify
scope; global JSON parsing untouched). Downstream normalized processing (pm_sync_events,
drift, orphans) unchanged. Suite 380 → 405 (20 unit + 5 e2e). **ADF descriptions for Jira, 2026-07-25 —
pillar 8's deferred list is now EMPTY.** New dependency-free `packages/pm-provider/src/adf.ts`:
`textToAdf` (paragraphs w/ hardBreak round-tripping, #-headings capped at 6, bullet/ordered
lists, code fences w/ language; total — never throws) and `adfToText` (inverse walk,
unknown nodes descended never dropped). `JiraAdapterOptions.apiVersion?: 2|3` (default 2,
zero behaviour change): v3 uses `/rest/api/3/`, converts the native description field and
comment bodies through ADF both ways. Migration 0022 adds nullable
`pm_connections.api_version` (null = v2; jira-only, superRefine-rejected loudly elsewhere);
admin form gains the v2/v3+ADF select. Adjacent fix: run pm-sync now seeds the mapped
description from the node's instruction at creation (initial value only — the PM tool owns
it thereafter per §3). Suite 405 → 416.

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
| COMPONENT-07 | Dev demo stack on AWS (`regulait-dev-app`) | **live** — EC2 `i-013c62adc887c76bb`, http://3.237.199.248:3000, dev-grade only; teardown = `terraform destroy` | ADR-0013 |
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
