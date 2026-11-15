# ADR-0320: Third-party cloud coding agents as governed pillar-7 workers

- **Status**: Accepted (owner decision 2026-11-15, gap G5, recorded by the master: "run third-party cloud coding agents as
  governed workers under the initiating user's limits; default off; fake servers until the owner approves live accounts")
- **Date**: 2026-11-15
- **Index**: **A worker-provider interface in the pillar-7 orchestrator dispatches a signed-off build stage to an external
  cloud coding agent (Cursor cloud agents, Devin, GitHub Copilot coding agent, OpenAI Codex through the Agents API) under
  the initiating user's entitlements and per-run budget, with the repository and branch pinned, the agent's PR captured
  into the normal PR → checks → merge-approval stages, cost attributed per call, every step audited, and a kill switch
  plus default-deny per provider.** Default off. Fake servers only until the owner approves live accounts.
- **Backlog item**: `internal/product/MARKET_ANALYSIS_2026-11.md` §3a G5 (PR #844, not yet merged)
- **Built in**: lane E5, four sequential PRs (§7)
- **Migration**: slice 2 adds `pending/cloud_worker_providers.sql` (numbered at merge, ADR-0252); slice 1 has none
- **Related**: [ADR-0219](0219-a2a-governance.md) (A2A governance, the choke-point pattern reused here),
  [ADR-0231](0231-sap-joule-agents-over-a2a.md) (vendor agents through A2A, card and credential handling),
  [ADR-0124](0124-kill-switch-and-safe-modes.md) (execution dial), [ADR-0251](0251-one-governed-decision-core.md) (one governed core),
  ADR-0016 / ADR-0078 (tighten-only delegation), ADR-0062 (mode-scoped egress), ADR-0176, ADR-0180, ADR-0200,
  ADR-0252, and lane E3's portable agent credential (no PR yet; see §5)

## Context

Enterprise customers already pay for cloud coding agents. Each runs in the vendor's cloud, clones the customer's
repository with its own GitHub access and opens a PR. None of them knows about the customer's plan gate, per-user
entitlements, project budget or audit trail. G5 asks that RegulAIt can hand the build stage of a pillar-2 workflow to
one of these agents and still enforce everything it enforces on its own workers.

RegulAIt already has the pieces:

- **Pillar 7.** `planRun` (`apps/gateway/src/orchestration.ts`) decides every node as the run's initiating user, with
  the lead-chain ceiling (`computeNodeCeiling`) and the per-node budget ceiling (`computeNodeBudgetCeiling`) that can
  only narrow. `chargeRunBudget` charges the run atomically.
- **Pillar 2.** An `automated_build` stage carries a nested task graph (`workflow-kernel` `stageSchema.run`) that
  `runGitExecutions` plans under `instance.initiatorUserId`. A build stage with a run cannot be human-triggered, so it
  runs only after the planning stage and sign-off before it. The `open_pr` executor records `context.prId` /
  `context.prUrl`, and merge refuses a stale round.
- **Remote agents.** `executeGovernedA2aCall` (`apps/gateway/src/a2a.ts`) is a single choke point: org flag, grant,
  lead ceiling and kill switch in `evaluateA2a`, the governed core, attribution and the budget gate, PII, guardrails,
  egress through `createGuardedFetch`, an encrypted credential, and one usage row plus one audit row per allowed call.

### Sources

Checked 2026-11-15. **Verified** means the page was fetched and says it. **Unverified** means it was not.

- **Cursor Cloud Agents API v1** (cursor.com/docs/background-agent/api/overview). `POST /v1/agents` with `prompt.text`,
  `repos[].url` and `startingRef` (branch name or 40-character SHA), `workOnCurrentBranch` (default false: Cursor pushes
  a new `cursor/...` branch), `autoCreatePR`, `model`, `mode` (`agent` or `plan`), and `agentId` (`bc-<uuid>`) for
  idempotent creates. `GET /v1/agents/{id}/runs/{runId}` gives a run status (`CREATING`, `RUNNING`,
  `WAITING_FOR_BACKGROUND_WORK`, `FINISHED`, `ERROR`, `CANCELLED`, `EXPIRED`) and `git.branches[].prUrl`;
  `POST .../cancel` cancels; `GET /v1/agents/{id}/usage` reports token usage. Basic or Bearer auth with a user or
  service-account key. Public beta. v1 has no webhook yet (v0 had one). **Verified.** The shape of the usage response
  is **unverified**.
- **Devin API v1** (docs.devin.ai). `POST /v1/sessions` with `prompt`, `title`, `tags`, `idempotent`, `secret_ids`,
  `knowledge_ids` and `max_acu_limit` (a positive integer); the reply has `session_id` and `url`.
  `GET /v1/sessions/{id}` gives `status_enum` (`working`, `blocked`, `expired`, `finished`, `suspend_requested`, …)
  and `pull_request.url`. Bearer auth with a personal (`apk_user_*`) or service (`apk_*`) key. **Verified.** The base
  URL `https://api.devin.ai/v1`, the deprecation of v1 in favour of v3 and the terminate endpoint are **unverified**.
  Devin has no repository field: the repository and branch are pinned in the prompt and checked on the result (§3).
- **GitHub Copilot coding agent.** The 2025-12-03 changelog says issues can be assigned to Copilot through REST
  ("add assignees", "create an issue", "update an issue"), with the target repository, base branch, custom
  instructions and custom agent configurable. **Verified** at that level. The REST field names, and the "agent tasks"
  endpoint (`POST /agents/repos/{owner}/{repo}/tasks`, API version 2026-03-10) that one third-party blog describes, are
  **unverified**.
- **OpenAI Codex.** The Agents API "gives your application access to the Codex harness through an OpenAI-managed API":
  `POST /v1/agents/sessions` with `OpenAI-Beta: agents=v1`, a hosted or self-hosted sandbox, streaming or webhooks for
  completion. **Verified.** How a session opens a PR on the customer's repository, and how it reports usage, are
  **unverified**. A `/v1/codex/cloud/tasks` endpoint described by one blog does not match OpenAI's docs and is not used.
- **A2A.** None of the four documents an A2A endpoint today (**unverified** that none exists). A provider that publishes
  an A2A card is called through `executeGovernedA2aCall` as an ordinary remote agent (ADR-0219, ADR-0231), not through
  this ADR's interface. `@a2a-js/sdk` stays at the pinned 1.3.0.
- **Open source first.** No maintained MIT/Apache/BSD/ISC client exists for these four APIs that also takes an
  injected fetch (needed for the egress guard, ADR-0062) and works air-gapped. Each adapter is a few request and reply
  mappings over our guarded fetch, written in the kernel as pure functions. `zod` (already pinned) validates every
  reply. The vendors' own SDKs (where they exist) are not used, because they carry their own HTTP client.

## Decision

### 1. The worker-provider interface (pillar 7)

A cloud worker is a **task-graph node** whose owner is a cloud worker provider instead of a RegulAIt agent. The node
gets an optional `cloudWorker` block. `@regulait/orchestration-kernel` gains `cloud-worker.ts`, pure and zero-I/O:

- `CLOUD_WORKER_PROVIDERS`: `cursor`, `devin`, `github_copilot`, `openai_codex`. Each has a readiness flag. `cursor`
  and `devin` are `fake_verified` (built against fake servers from the verified contract). `github_copilot` and
  `openai_codex` are `contract_unverified`: the gateway refuses to dispatch to them until a later slice verifies the
  contract and flips the flag in code.
- `cloudWorkerTaskSchema`: provider, pinned repository (`host`, `owner`, `name`), pinned base branch, the branch prefix
  the work branch must start with (default `regulait/<runId>/`), the prompt, and a per-dispatch budget cap.
- Per provider, a **request builder** (`buildLaunchRequest`, `buildStatusRequest`, `buildCancelRequest`) that returns
  method, path and JSON body, and a **reply parser** (`parseLaunchReply`, `parseStatusReply`) that validates the reply
  with zod and maps it to one vocabulary: `running`, `needs_input`, `succeeded`, `failed`, `cancelled`, plus the PR URL
  and any reported usage. Anything unrecognised parses as `failed` (fail closed).
- `decideCloudDispatch(input)` is the pure envelope check (§2). `checkCapturedPr(task, pr)` is the scope check (§3).
  `providerSpendLimit(provider, remainingUsd, price)` turns the remaining budget into the provider's own limit
  (`max_acu_limit` for Devin) where the provider offers one.

The gateway does all I/O: it loads state, calls the kernel, sends through the guarded fetch, writes rows.

### 2. Dispatch is the same decision as any other worker, plus five checks

`executeGovernedCloudWorkerDispatch` in a new `apps/gateway/src/cloud-workers.ts` is the single choke point, shaped
after `executeGovernedA2aCall`. In order, any failure is a deny with one audit row and no upstream contact:

1. **Org flag** `cloud_workers_enabled`, default `false`. Turning it on is a relaxation (`settings_relax` step-up,
   audited) through `org-setting-strictness.ts`.
2. **Provider enabled for this tenant.** A row in `cloud_worker_providers` per provider, created disabled. Enabling one
   is admin-only, a step-up, audited. **Kill switch:** each row has `halted_at` / `halted_reason`; a halted provider
   refuses new dispatches and the gateway cancels its live dispatches. The org-wide execution dial (ADR-0124) applies
   too: `halted` and `read_only` refuse, `require_approval` queues. A dispatch is a write.
3. **Plan gate signed off.** The build stage's workflow instance must have passed its planning stage and the human
   sign-off before it. A dispatch outside a workflow instance is refused (no ad-hoc cloud workers).
4. **Entitlement, never more.** The person needs a grant on the provider (`cloud_worker_grants`, per person, default
   deny), the node's lead ceiling must allow the provider, and the governed core (`governedEvaluateResource`) applies
   the attribution mandate, rate limits and approval rules. The repository must be one the person may already change
   through the workflow's git connection: the dispatched scope is the intersection of the person's entitlements and the
   node's ceiling, never the provider account's.
5. **Budget.** `assertProjectAttribution` and `preDispatchProjectGate` as for every call. The dispatch reserves its
   budget cap with `chargeRunBudget` before launch; a cap above the node's budget ceiling or the run's remaining budget
   is refused. Where the provider has a spend limit, it is set from the reservation.
6. **Scope pinned.** Repository, base branch and branch prefix come from the stage's git connection and the run, never
   from the prompt or the provider. Cursor is told `workOnCurrentBranch: false`, `autoCreatePR: true` and a
   `startingRef` of the pinned base branch.
7. **PII, guardrails and egress** as in A2A: the prompt goes through `enforcePII` (redact mode refuses), the guardrail
   policy, and `checkMcpServerUrl` plus `createGuardedFetch` on the provider's registered base URL.
8. **Credential** opened last (§5) and sent only on the registered origin.

### 3. The result is captured, checked and handed to the normal stages

- The gateway polls the provider (no vendor webhook is relied on; Cursor v1 has none) with a bounded interval and an
  absolute deadline (default 2 hours, admin may lower it). Each poll is audited at state change only.
- On `succeeded`, `checkCapturedPr` requires that the PR is on the pinned repository and host, targets the pinned base
  branch, and comes from a branch that starts with the pinned prefix — the last two read from the git provider through
  the workflow's own connection, not from the coding agent's reply. Devin and Cursor choose their own branch name, so
  for them the gateway checks the PR's head branch against the provider's documented prefix (`cursor/`) or the run
  prefix the prompt asked for, and an unexpected one fails the dispatch (`scope_escape`) and is audited.
- A captured PR is written to the instance as `context.prId` / `context.prUrl` with a `regulait-instance` /
  `regulait-round` body line added through the git provider, exactly like the `open_pr` executor. From there the
  existing `automated_check` and merge-approval stages run unchanged, and merge keeps its stale-round refusal. The
  coding agent never merges: its own merge or auto-merge setting is not used, and a PR that arrives already merged
  fails the dispatch.

### 4. Cost

- One `usage_events` row per dispatch (`object_type = 'cloud_worker'`, `project_id`, `cost_usd`), written in the same
  transaction as the allow audit row, as in A2A.
- The cost is the provider's reported usage priced by the admin's per-provider price table where the provider reports
  usage (Devin ACUs, Cursor tokens). Where it does not, the reserved cap is charged in full. Secure default: the
  reservation is only released down to the measured cost, never up.
- Every poll and cancel is attributed to the same usage row; there is no second charge.

### 5. Credentials (no second ADR yet)

Slice 2 stores one credential per provider per tenant in `cloud_worker_credentials`: data-key envelope
(`secret_ciphertext`, listed in `CIPHERTEXT_COLUMNS`), last four characters only, never returned, logged, audited or
put in a prompt; rotation replaces the row and is audited; deleting the provider deletes it. These are service-account
keys (Cursor service account, Devin `apk_*`), so the provider's actions are attributed to RegulAIt's account and our
audit names the initiating person. Lane E3's portable agent credential has no PR yet. When it lands, a
provider that can verify it gets the person's down-scoped credential as well, and that wiring is a second ADR from this
lane's reserved pair. Until then the second number stays unused.

### 6. What is not built

- No screens. The admin routes are API only and listed in `KNOWN_UI_GAPS` against #453.
- No live calls. Every test runs against a local fake server. Live accounts need the owner's go-ahead.
- No vendor webhook intake until a provider documents a signed webhook (then it follows the webhook-signature and replay
  rules in CLAUDE.md's checklist).

### 7. Slices

1. This ADR and the pure kernel module (`cloud-worker.ts`): schemas, the four request builders and reply parsers, the
   envelope and scope checks, spend-limit conversion, tests. No migration, no route.
2. Tables (`cloud_worker_providers`, `cloud_worker_grants`, `cloud_worker_credentials`, `cloud_worker_dispatches`),
   the org flag, `executeGovernedCloudWorkerDispatch`, admin routes, the kill switch; tests against fake Cursor and
   Devin servers.
3. The `cloudWorker` task-graph node in `planRun` and the build stage, polling, PR capture into the instance context,
   cost reconciliation; an end-to-end test from sign-off to merge approval on fake servers.
4. Copilot and Codex adapters once their contracts are verified, and the credential ADR if E3's credential has landed.

## Consequences

- A cloud coding agent is governed by the same decision as a RegulAIt worker, so the tighten-only invariant holds across
  vendors.
- The provider's own repository access is wider than the person's. The scope check after the fact (§3) and the pinned
  prompt reduce, but do not remove, that gap: a provider could push elsewhere with its own token. Customers should give
  each provider's GitHub app access to the pinned repositories only. This is written into the admin route's response.
- Polling costs requests; the interval is bounded and per-dispatch.

## Owner answers (2026-11-15, relayed by the master on #847)

- **Approvals.** A dispatch follows the project's normal approval rules, and the execution dial's `require_approval`
  queues it (§2), as built. No extra always-on approval.
- **Live tests.** The owner approved sandbox testing in general, but **not** GitHub or Cursor sandbox accounts for this
  lane. Every coding-agent provider stays on fake servers.
- **Pace.** A pilot in about two weeks takes CI priority, and outside coding agents are not a pilot success criterion.
  Slices 2–4 are paused after slice 1 until the master resumes the lane. Lane E3 will publish the portable credential
  format that the second ADR in this lane's pair builds on (§5).
