# RegulAIt — Architecture & Sequencing Roadmap

> **Status:** planning document, not a decision record. Nothing here is committed until the
> owner picks an order. Written 2026-07-30, immediately after the four-area cleanup batch
> (addendum 33) and *during* the then-in-flight governance-gaps batch described below.
> **Refreshed 2026-07-30 (housekeeping batch)** after governance-gaps (migration 0036,
> ADR-0019), Batch H (migration 0037, ADR-0020) and the temperature amendment (`fdfeff1`)
> all merged: counts, migration numbers and batch statuses below reflect that state, and §6
> (orphaned deferrals) was added.
>
> **Audience:** the project owner, and any future Claude session picking this up cold.
> Read `CLAUDE.md` → `project-state/STATE.md` → this file, in that order.
>
> **Ground rule inherited from `CLAUDE.md`:** nothing gets a "production" designation, and
> nothing deploys to one, without the owner's direct, explicit, in-session sign-off. Batch F
> below is gated on that conversation, not on engineering readiness.

---

## 1. Where the build actually stands

All eight P0 pillars have a **working, deployed slice**. That is a real milestone and it is
also a narrower claim than it sounds. Precisely:

**What it means**
- Every pillar has code, tests, a migration history, and a UI surface on the live dev stack
  (`http://3.229.246.126:3000`, EC2 `i-013c62adc887c76bb`, ADR-0013).
- The load-bearing *invariants* are enforced and tested, not asserted in prose: default-deny
  survives every path; the optimizer can never widen entitlement; delegation only ever
  tightens (agent ceiling ADR-0016 + budget ceiling); one audit trail, one approvals queue;
  measured spend is distinct from estimated spend and neither invents a dollar.
- ~36k lines across 11 packages + the gateway; suite = **432 gateway tests** as of the
  Batch H + temperature-amendment merges (was ≈361 at STATE.md addendum 33) plus per-package
  suites. All green locally at last verification.

**What it does NOT mean**
- It does not mean the pillars are *complete*. Several pillars have a full spine and a thin
  outer layer — most visibly pillar 3 (infra-ops is mock-only; BYOC cloud execution is a
  dry-run shape) and pillar 1's connector breadth.
- It does not mean the deployment is production-grade. It is explicitly dev-grade: HTTP only,
  single EC2 box, container Postgres, demo data (ADR-0013).
- It does not mean the **provider-agnostic standing principle** is satisfied. That is the
  headline gap and it gets its own section.
- **It does not mean the governance reaches the developers it is for.** Every spec here describes
  governing agents that come *to* our gateway; a developer using Copilot or Cursor never touches
  it. Raised by the owner 2026-07-30 and written up as **Batch H**, which is a scope gap in the
  product thesis rather than an item of backlog. Half of it — tool calls over MCP — already works
  and is simply not marketed. **Since SHIPPED the same day** (migration 0037, ADR-0020) — see
  Batch H below, now a record of what shipped rather than a proposal.

**Since MERGED (PR #44, migration 0036, ADR-0019 — was in flight when this was written):**
per-user revocation of role-derived agent/connector grants (clears the ADR-0014 deferral);
MCP-proxy project attribution + PII enforcement (clears the last "mcp path honestly DEFERRED"
note from the compliance-enforcement slice); suppressing streaming for block-mode PII projects
(clears the KNOWN LIMIT recorded in STATE.md — output-block could transiently flash raw text);
and the `data_sensitivity` 6th assignment dimension (clears the ADR-0018 deferral). All four
are done. Everything in this roadmap starts *after* them.

---

## 2. THE HEADLINE GAP — provider-agnostic claim vs shipped reality

`CLAUDE.md` states, as a standing principle applying to all eight pillars: *"RegulAIt never
hard-locks to one vendor at any layer."* Here is the truth table, read off the registries.

| Layer | Claimed in `CLAUDE.md` | Actually shipped | Registry file | Behavior for the rest |
|---|---|---|---|---|
| **Model / agent** | any publicly available model | **COMPLETE** — anthropic, openai, google, xai, mock all resolve | `packages/model-provider/src/index.ts` (`resolveModelProvider`, ~L1591) | n/a — no kind is rejected |
| **PM tool** | ADO, Jira, Linear, Asana, monday + generic webhook | **COMPLETE** — all six + mock resolve | `packages/pm-provider/src/index.ts` (`resolvePmProvider`, ~L1317) | n/a — no kind is rejected; switch stays exhaustive so a new kind is a compile error |
| **Git provider** | GitHub, GitLab, Bitbucket, Azure DevOps | **GitHub only** (+ in-memory mock) | `packages/git-provider/src/index.ts` (~L205 switch) | `gitlab` / `bitbucket` / `azure_devops` throw `GitProviderError("…interface-ready but its adapter is not implemented yet")` |
| **Connectors** | (implied by pillar 1's "every connector") | **half** — `mock`, `generic`, `http`, `webhook` execute | `packages/connector-provider/src/index.ts` (~L300 switch) | `slack` / `github` / `jira` / `snowflake` throw `ConnectorProviderError(…, 501)` |
| **Cloud / deploy target** | BYOC into AWS, Azure or GCP + on-prem/air-gapped | **shapes only** — all five kinds resolve, none mutates a real cloud | `apps/gateway/src/deploy.ts` (`resolveDeployProvider`, ~L354) | `aws` has a real `@aws-sdk` STS path behind the **off-by-default** `REGULAIT_DEPLOY_LIVE` flag with an injected client (ADR-0015 A1); `azure` / `gcp` / `kubernetes` are deterministic dry-runs with `// REAL:` markers, every result string suffixed `[dry-run]` |
| **Infra-ops (pillar 3 §8.2)** | drift / CVE / cert / backup automation across clouds | **mock only** | `packages/infra-provider/src/index.ts` (~L403 switch) | `aws` / `azure` / `gcp` all throw `InfraProviderError(…, 501)`; the aws case carries a written-out `// REAL:` plan (STS AssumeRole → SSM patch / ACM rotate / AWS Backup restore) |
| **Our own dev infra (Terraform)** | *explicitly out of scope* | AWS-only, by design | `infra/` | `CLAUDE.md`'s scope note: the principle governs the product, not our bootstrap tooling (ADR-0002/0003). This row is **not** a gap. |

### The honest statement

> The provider-agnostic principle is today **a design commitment honored by interface shape
> and honest failure, not by shipped adapters.** Two of six product layers (model, PM) are
> genuinely vendor-plural. Four are not.

That is not nothing — it is materially better than a hard-coded integration, because:
- Every layer has a **neutral interface** the gateway codes against, so adding a vendor is a
  new file, not a refactor. Proven twice: the OpenAI, Google and xAI model adapters each
  required **zero gateway changes**, and so did four of the six PM adapters.
- Unimplemented vendors **fail explicitly** (501 / typed provider error), never silently
  succeed, never silently fall back to a different vendor. That discipline is uniform.

Two sharp edges worth naming:
1. **`git_connections.provider` accepts kinds the registry rejects.** The DB enum is
   `["github","gitlab","bitbucket","azure_devops","mock"]`
   (`packages/db/src/schema.ts` ~L593) but only two resolve. An admin can create a GitLab
   connection through the portal and it only fails later, at `git_operation` stage execution.
   Recommend either narrowing the accepted set at creation time or surfacing a
   "not-implemented" badge in the admin Git Connections UI. *(Recommendation only — I am not
   editing schema or portal in this pass.)*
2. **A dry-run deploy returns a success shape.** `azure` / `gcp` / `kubernetes` deploy stages
   will advance a workflow past `deployment` having deployed nothing. The `[dry-run]` suffix
   in the detail string is the only tell. Acceptable while it is labeled and while nothing is
   production — but it must not survive contact with a real customer environment.

### What it would take to make the claim true

Per layer, the same proven playbook (see Batch A/B/C): **neutral interface already exists →
adapter file with injectable `fetch` → fake upstream server in a `*.test.ts` → e2e proving the
real adapter puts the right auth on the wire.** This is the pattern behind every adapter
already shipped (`packages/pm-provider/src/index.test.ts`, `apps/gateway/src/deploy-byoc.test.ts`,
`apps/gateway/src/pii.test.ts` all use it). Rough totals: git ≈ 3 adapters, connectors ≈ 4,
infra-ops ≈ 1–3, cloud deploy ≈ 3 real execution paths. **Repetitive, not hard.**

---

## 3. The batches

Size key: **S** = one focused slice. **M** = a few slices / one working session. **L** =
multi-session, or gated on an external decision.

---

### Batch A — Git-provider breadth (GitLab, Bitbucket, Azure DevOps)

| | |
|---|---|
| **Goal** | Make pillar 2's `git_operation` stage work on the three non-GitHub providers `CLAUDE.md` promises. |
| **Work items** | GitLab adapter (REST v4, `PRIVATE-TOKEN` header, MRs not PRs — the vocabulary mapping is the only real design work); Bitbucket Cloud adapter (REST 2.0, app-password Basic auth, `pullrequests`); Azure DevOps Repos adapter (REST 7.x PAT — **note the PAT/auth code already exists** in the pm-provider ADO adapter and can be mirrored). Optionally: narrow `git_connections` creation to implemented kinds (sharp edge #1 above). |
| **Files** | `packages/git-provider/src/index.ts` (+ `index.test.ts`); admin Git Connections UI in `apps/gateway/src/admin-portal.ts` if the badge/narrowing is included |
| **Migration?** | **No** — the schema enum already carries all four kinds |
| **Size** | **M** (3 adapters × ~S each; they are near-independent) |
| **Risk / deps** | Very low. Isolated package, no governance surface touched, no gateway change expected (the executor keys off the provider string, exactly like model dispatch did). Only shared-file risk is the admin portal if the UI item is included. |
| **Worth doing?** | **Only when a real target repo exists.** GitHub is the only provider anyone has actually pointed this at. Building three adapters speculatively produces three untested-against-reality integrations and three more surfaces to keep green. The *honest failure* behavior is already correct. **Do this when a customer/demo names a specific git host** — then build that one, in an afternoon. |

---

### Batch B — Connector-kind breadth (Slack, GitHub, Jira, Snowflake)

| | |
|---|---|
| **Goal** | Turn the four 501-ing connector kinds into real metered, governed integrations. |
| **Work items** | Slack (`chat.postMessage` / `conversations.history`, Bearer bot token); GitHub (REST, issues/repos read+write — distinct from the *git* provider, this is the connector data plane); Jira (REST v2, Basic `email:token` — **the pm-provider Jira adapter is a direct template**); Snowflake (SQL API v2, key-pair or OAuth — the only genuinely new auth shape and the only one that needs care around what a "read" vs "write" operation means for data-scope rules). |
| **Files** | `packages/connector-provider/src/index.ts` (+ `index.test.ts`); possibly `apps/gateway/src/agents-connectors.ts` if a kind needs a config field beyond `baseUrl`/`token` |
| **Migration?** | **Probably not** — `connectors` already carries `provider_kind` / `base_url` / `price_per_call_usd` and `connector_credentials` exists (migration 0025). A migration is only needed if Snowflake's key-pair auth won't fit the single-ciphertext credential shape. **Verify before starting.** |
| **Size** | **M** (Slack/GitHub/Jira are S each; Snowflake is S–M) |
| **Risk / deps** | Low-moderate. The invariant to preserve is the one from migration 0025: *one allowed call = exactly one audit row + exactly one `usage_events` row; denied → 403 no bill; upstream failure → 502 no bill.* Any new adapter must not break that. Snowflake is the one where "operation" granularity interacts with pillar 1's `allowedObjects` data scope — worth thinking through, not just coding. |
| **Worth doing?** | **Higher value than Batch A**, because connectors are the pillar-1 demo surface (a governed Slack post is a legible five-second demo; a governed GitLab MR is not). Slack alone is probably worth doing on its own. Still: build the one you can demo, not all four. |

---

### Batch C — Infra-ops + BYOC real execution (pillar 3's outer layer)

| | |
|---|---|
| **Goal** | Move pillar 3 from "governed operations over a mock" to "governed operations over a real cloud", starting with AWS. |
| **Work items** | (1) `AwsInfraProvider` — the `// REAL:` plan already written into `packages/infra-provider/src/index.ts` L~410: STS AssumeRole into the customer role, then SSM Patch Manager (CVE), ACM (cert rotation), AWS Backup (restore) driving `scan()`/`remediate()`. (2) Azure + GCP infra adapters. (3) Real execution for the `azure`/`gcp`/`kubernetes` deploy adapters, following the AWS pattern from ADR-0015 A1 — injected client, off-by-default flag. (4) ADR-0015 **A4** (design-only; the sharpest record of what it actually is now lives in ADR-0019's "A4 stays deferred" section): per-mode policy + mode-aware audit retention. |
| **Files** | `packages/infra-provider/src/index.ts`, `apps/gateway/src/deploy.ts`, `apps/gateway/src/infra.ts`, tests |
| **Migration?** | Not for (1)–(3). **Yes for A4** (a nullable `mode` column or structured policy — the ADR-0015 addendum records the design). |
| **Size** | **L** |
| **Risk / deps** | **Highest risk in the roadmap.** This is the only batch that can mutate real cloud resources. It must keep the existing safety architecture: off-by-default flag, injected client, fake in tests, no live mutation in any test path. It also touches the standing guardrail — patching or rotating a cert on a real account is exactly the kind of thing that needs explicit sign-off. Depends on nothing else technically, but depends on a *conversation* about which account it may touch. |
| **Worth doing?** | **Wait.** The governed spine (detect → propose → approve → remediate → ledger) is the intellectually hard part and it is *done* (ADR-0017, migrations 0027 + 0034). The remaining work is cloud-SDK plumbing with real blast radius and no customer asking for it yet. The mock demonstrates the whole spectrum keylessly. Revisit when there is a specific account, a specific resource, and explicit sign-off. **On A4, use ADR-0019's precise decomposition, not the old "small and safe, pull into Batch D" line:** A4 = (a) a populated mode/`deploy_context` dimension on `audit_log` — with an honest story for pre-existing rows, which have no mode and cannot be backfilled; (b) a **MAX-only** per-mode retention override, so retention can never be shortened; and (c) mode-scoped restriction rules extending migration 0026's rule-scoping model. (a)+(b) are genuinely small and could be pulled forward; (c) is a change to the pillar-1 policy model and deserves its own slice + ADR. |

---

### Batch D — Depth & polish on already-shipped surfaces

| | |
|---|---|
| **Goal** | Close the accumulated "Deferred:" lines across the ADRs and STATE.md addenda. These are all *known, named* gaps in things that already work. |
| **Work items** | See table below — this batch is a menu, not an all-or-nothing. |

| Item | Source of the deferral | Files | Migration? | Size |
|---|---|---|---|---|
| Streaming for worker-node / auto dispatch | STATE.md streaming addendum ("runs are backend-driven, no client watching") | `apps/gateway/src/orchestration.ts` | No | S |
| OpenAI **Responses API** surface | STATE.md OpenAI-adapter addendum | `packages/model-provider/src/index.ts` | No | S |
| Per-provider tool-use nuances (Google is currently *best-effort* in the agentic loop) | STATE.md tool-using-workers addendum | `packages/model-provider/src/index.ts` | No | S–M |
| **Context-compaction per-user dials** (threshold + recent-window are module constants today: `DEFAULT_COMPACTION_THRESHOLD_TOKENS = 1600`, `COMPACTION_RECENT_WINDOW_MESSAGES = 4`) | STATE.md compaction addendum — explicitly "deferred pending an agent-policy migration home" | `packages/optimizer-kernel/src/index.ts`, `packages/db/src/schema.ts` (`user_agent_policies`, ~L391 — the natural home, it already hosts `routing_mode` and `run_budget_usd`), `apps/gateway/src/agents-connectors.ts` | **Yes** — two nullable columns on `user_agent_policies` | S |
| `agents.systemPrompt` column (prompt caching currently sources the cacheable prefix from an optional request field because the column doesn't exist) | STATE.md prompt-caching addendum | `packages/db/src/schema.ts` | **Yes** | S |
| Admin portal **ADR-0012 deferrals**: SPA rewrite, SCIM/SSO status, SIEM export, dry-run of *unsaved* policy, bulk actions, CSV export | ADR-0012 §4. Note: **CSV export shipped** for costs/usage-events (migration 0028 slice); the audit-log CSV/SIEM path did not. SCIM/SSO have **no backend at all** — grep finds zero `SCIM`/`SAML`/`SIEM` references in `apps/gateway/src/`, only in the specs. | `apps/gateway/src/admin-portal.ts` (1603 lines — **the serialization chokepoint**) | Varies | see below |
| Compliance: `mcpDefaultMode` still labeled `declared-not-enforced` (`apps/gateway/src/projects.ts:1591`) | Compliance-cascade addendum. **Check after the in-flight batch** — the MCP-proxy PII/attribution work may close this. | `apps/gateway/src/projects.ts` | No | S |
| ADR-0015 **A4** (per-mode policy + mode-aware audit retention) | ADR-0015 addendum; sharpest record now in ADR-0019 ("A4 stays deferred") — see Batch C for the (a)/(b)/(c) decomposition; only (a)+(b) belong in this batch | `apps/gateway/src/deploy.ts`, schema | **Yes** | S |

| | |
|---|---|
| **Risk / deps** | Low per item. **The dependency that matters:** several items touch `packages/db/src/schema.ts` and `apps/gateway/src/admin-portal.ts`. Those must be **serialized** (see §4). Each migration must own a distinct number — highest applied is **0037**, next free is **0038**, and **0038 is being claimed by the org-settings batch in flight** — check the directory AND `packages/db/migrations/meta/_journal.json` before taking a number. |
| **Worth doing?** | **This is the best value-per-risk in the roadmap.** Every item is small, well-understood, in a surface that already has tests, and closes a documented promise. The compaction dials and the `agents.systemPrompt` column in particular remove "we hardcoded it" caveats from two pillar-6 techniques. **Recommend doing a selected subset of this first.** The SPA rewrite is the exception — see §5. |

---

### Batch E — Housekeeping / project hygiene

| | |
|---|---|
| **Goal** | Restore the safety nets and the accuracy of the project's own record. Cheap, and two items are actively costing us. |

| Item | Detail | Size |
|---|---|---|
| **Re-enable CI** | `.github/workflows/ci.yml` is `workflow_dispatch:`-only because the account's GitHub Actions minutes are exhausted (addendum 32). The `pull_request:` / `push: branches: [main]` triggers are kept **commented immediately below** for a one-line revert. Do this the moment minutes are topped up. | XS |
| **While CI is paused, the ONLY gate is a clean `pnpm -r build` on the MERGED state** | This is the hard-won lesson and it deserves to be loud. `pnpm -r test` does **not** catch type errors in test files, but the Docker image build runs `pnpm -r build`, which type-checks them (each package tsconfig is `include: ["src"]`). **This actually happened** — merged `main` did not build in Docker, discovered only during a redeploy (addendum 32, PR #38). Two test files had shipped through merges with type errors. **Every merge must be followed by `pnpm -r build` + `node scripts/check-ui-syntax.mjs` on the merged tree, not just on the branch.** | — |
| **STATE.md Epics/Components tables are stale** | **DONE — already fixed.** The Epics/Components tables now carry shipped statuses, the COMPONENT-07 duplication is resolved (workflow orchestrator re-IDed COMPONENT-10), and the Decisions section defers to `docs/decisions/README.md` as the authority on ADR count instead of restating a number. The front-matter `last_session` / addenda-date mismatch is documented in STATE.md itself as accurate (no newer session file exists). Kept here only so a reader of an old copy knows it closed. | — |
| **The graphify knowledge graph does not exist** | **DONE — CLAUDE.md wording softened** (housekeeping batch): it now says the graph is locally generated, absent in fresh clones (`graphify-out/` is `.gitignore`'d by design), and regenerable via `graphify update . --code-only`; the ADR-0005 `--code-only` security constraint stands unchanged. | — |
| **AWS follow-ups from STATE.md** | **Terraform AUTHORED (housekeeping batch), deliberately NOT applied.** (a) CIS v1.2.0 Security Hub subscription is now an explicitly managed, variable-gated resource (`enable_cis_standard`) in both accounts — flipping it off needs a one-time `terraform import` (documented in the module) since the auto-enabled subscriptions were never in state. (b) The Config aggregate authorization now covers all `allowed_regions` (for_each + `moved` block); the deeper gap — recorders exist only in `us-east-1`, so `us-east-2` resources go unrecorded — is a documented TODO until anything lands there. (c) Budget gained a FORECASTED 100% notification; the $5 cap tripping on the ~$15–30/mo dev stack is expected (ADR-0013), and raising it re-opens OQ-002 — owner's call. `terraform validate` passes; apply is a separate, credentialed step. | S |

| | |
|---|---|
| **Files** | `.github/workflows/ci.yml`, `project-state/STATE.md`, `CLAUDE.md`, `infra/` — **all outside this document's write scope; listed as recommendations** |
| **Migration?** | No |
| **Size** | **S** overall |
| **Worth doing?** | **Yes, and soon.** The CI item is the one that has already bitten us once. The STATE.md accuracy item matters disproportionately for a project whose entire continuity model is "this file is the only thing that persists" — a future session reading `Policy/allow-list engine — not started` could waste an hour or, worse, rebuild it. |

---

### Batch F — Productionization

| | |
|---|---|
| **Goal** | Whatever the dev stack would need to stop being dev-grade. |
| **Work items** | TLS + a real domain (today: plain HTTP on a public IP); managed Postgres (today: a container volume on the same box — a `terraform destroy` or an instance replacement loses everything); ALB + auto-scaling group instead of one EC2 box; real secrets management (today: per-deploy random runtime config generated by the Terraform module) — AWS Secrets Manager or SSM Parameter Store, with `REGULAIT_DATA_KEY` in particular moved off the box; automated backups + a tested restore; the `github-oidc-role` module (authored, deliberately never wired into `main.tf`) wired up for real CI deploys; log/metric shipping. |
| **Files** | `infra/modules/app-instance`, `infra/environments/regulait-dev-app`, new module(s), `Dockerfile`/`compose.yml` |
| **Migration?** | No app migration; a Postgres **data migration** from the container volume to RDS would be needed |
| **Size** | **L** |
| **Risk / deps** | Depends on Batch E's CI restoration to be sane. Also note the operational quirk recorded in the session log: `registry.terraform.io` is blocked from the remote dev container — providers install via a filesystem mirror fed from `releases.hashicorp.com`. |
| **Worth doing?** | **GATED ON A CONVERSATION, NOT ON ENGINEERING READINESS.** Per the standing guardrail in `CLAUDE.md`: *nothing gets a "production" designation, and nothing deploys to one, without the owner's direct, explicit, in-session sign-off.* No `prod`/`production` account, tag, or CI role may be created or used before that. ADR-0013 says the same: "anything beyond demo use needs a new decision + explicit sign-off." So this batch cannot be scheduled by a Claude session on its own initiative — it starts when the owner says it starts. **Two items are arguably dev-grade-hygiene rather than production-designation and could be done sooner if the owner agrees they don't cross the line: managed/backed-up Postgres (data loss risk is real today) and moving `REGULAIT_DATA_KEY` off the instance.** Worth asking. |

---

### Batch G — The parked item: wire the owner's Anthropic API key

| | |
|---|---|
| **Goal** | `/app` chat calls real Claude instead of the mock provider. |
| **Work items** | Store the owner's key as an encrypted **platform** `model_credentials` row (AES-256-GCM under `REGULAIT_DATA_KEY`, write-only API — the surface already exists and is tested). No new code is expected: the ENV fallback, platform-credential path, and BYO-user-credential precedence all already ship, and `GET /v1/model-providers/status` already drives the composer's not-configured banner. |
| **Files** | None expected — this is a configuration action against the running stack |
| **Migration?** | No |
| **Size** | **XS** |
| **Risk / deps** | Real spend starts flowing. Pillar 5's budgets/attribution are exactly the mitigation, and they are live — set a project budget first. |
| **Worth doing?** | **Yes, whenever the owner has the key.** It is explicitly **parked at the owner's instruction** until then (session log, 2026-07-24-session-02.md:1105). It is the single highest-impact-per-minute item in the whole roadmap: it converts every demo from "mock replies" to "real Claude", with zero engineering. |

---

### Batch H — IDE / existing-agent interception — **SHIPPED 2026-07-30**

> **Status: SHIPPED** (migration 0037, ADR-0020; `apps/gateway/src/compat-anthropic.ts` /
> `compat-openai.ts` / `compat-core.ts`; a 46-test `ide-interception.test.ts` suite; amended
> same day by `fdfeff1` — `temperature` is **accepted-and-disclosed** via
> `x-regulait-ignored-fields` + an audit row instead of 400ing, per ADR-0020 §5, because real
> IDE clients send it unconditionally). What shipped: `POST /v1/messages` (Anthropic shape) and
> `POST /v1/chat/completions` (OpenAI shape) as translation shims over the one
> `executeGovernedDispatch` core, with real SSE; the singleton `interception_settings` row
> making every surface an admin choice (compat surfaces default **off**, disabled = 404 not
> 501); the three-mode model→agent resolution policy below; a declared `enforcement_posture`;
> `require_project_attribution`; and the admin "Client Access" tab with per-client config
> generation and an honest coverage table. Invariant proven in tests: the compat surface creates
> **no privilege path** — unentitled 403s, revocations deny through it, and an unresolvable
> model is default-deny with zero usage rows. The rest of this section is kept as the **record
> of the design that shipped** and of the follow-ons that did not (OTel observe rung, per-role/
> project resolution overrides, key-custody/network rungs, the compat long tail — see §6).
>
> Originally raised by the owner, 2026-07-30: *"most developers will be using AI agents directly
> on existing coding platforms like VS Code, Eclipse etc — can our tool latch onto those?"* This
> was the largest single hole found so far, and it was a **scope** hole rather than a defect:
> every spec in `docs/product/` describes governing agents that come **to** our gateway. A
> developer running Copilot or Cursor never touched it, so the governance was invisible to
> precisely the population it exists to cover.

**The honest framing.** RegulAIt today governs *calls that arrive at it*. Nothing enforces that a
developer's IDE sends its calls here. Until that is closed, "default-deny governance over every
agent/model call" is true of our surface and untrue of the developer's day.

**What already works, today, with zero build.** `POST /mcp/:serverId` (`apps/gateway/src/mcp-proxy.ts:455`)
is a spec-compliant streamable-HTTP MCP proxy with the full kernel behind it — allow-lists,
data-scope, rate limits, approvals, audit, and (since ADR-0019) project attribution + PII. Any
MCP-capable client can point at it right now: Claude Code, Cursor, Cline, Windsurf, Zed, VS Code's
MCP support. That governs **tool calls** — file writes, repo access, DB queries — which is
arguably the higher-blast-radius half. It is done and it is not being marketed.

**The actual gap.** There is **no provider-shaped endpoint**. The gateway exposes
`/v1/agents/:agentId/invoke` — our own shape, which no IDE speaks. There is no `/v1/messages`
(Anthropic shape) and no `/v1/chat/completions` (OpenAI shape), so every **model completion** an
IDE agent makes goes straight to the vendor, taking with it the spend (pillar 5), the token
optimization (pillar 6), the PII enforcement, and the audit trail.

The fix is smaller than it sounds: `executeGovernedDispatch` (`apps/gateway/src/agents-connectors.ts:146`)
is already a reusable core taking `{userId, served agent, input|messages, system, tools, …}` and
running governance → routing → optimization → dispatch → PII → ledger. A provider-compatible
endpoint is a **translation shim in front of it**, not a second engine — the same shape that let
the OpenAI, Google and xAI adapters land with zero gateway changes.

#### The interception ladder — pick a rung deliberately

This determines whether the product is real governance or an honor system.

| Rung | Mechanism | Bypassable? | Cost |
|---|---|---|---|
| **Observe** | ingest the OpenTelemetry that Claude Code and others already emit | n/a — no enforcement | S |
| **Voluntary (tools)** | developer adds our MCP server | trivially | **none — already shipped** |
| **Voluntary (models)** | developer sets the IDE's base URL to us | trivially | **one shim (this batch)** |
| **Managed** | admin pushes IDE policy / managed settings / MDM env vars | developer can undo locally | M |
| **Enforced — key custody** | org never issues raw provider keys, only RegulAIt keys | **no — no key, no call** | **~none; it is policy, not code** |
| **Enforced — network** | RegulAIt is the only sanctioned egress to `api.anthropic.com` et al | no | L (fits BYOC, pillar 3) |

**Key custody is the row to underline.** It needs almost no code — platform and per-user
credentials are already stored AES-256-GCM and never returned — and it is the cheapest path to
*non-bypassable* governance. If developers never hold a raw vendor key, pointing the IDE at
RegulAIt stops being a request and becomes the only way to get a completion.

#### Decided design — model→agent resolution is an ADMIN POLICY, not a constant

The owner's call (2026-07-30), and a better answer than any single mode: an IDE sends
`model: "claude-opus-5"`, not an agentId, so the admin **chooses the resolution mode** rather than
inheriting ours. All three ship, selectable per deployment (and plausibly overridable per
role/project, mirroring the rule-scoping model of migration 0026):

| Mode | Behavior | Suits |
|---|---|---|
| `map_by_model` | resolve to the governed agent whose `agents.model` matches; entitlement, tier ceiling and pricing then apply exactly as in `/app` | least developer friction; the sensible default |
| `require_agent` | the caller must name the agent (`x-regulait-agent-id`); the model name is advisory | strictest; explicit attribution per call |
| `router_decides` | treat the requested model as a **hint** the pillar-6 router may override for cost | maximum optimization; the IDE may get a different model than it asked for — must be disclosed in the response, never silent |

**Invariant that binds all three:** an unmapped or unresolvable model is **default-deny**, never a
silent pass-through to the vendor. That is the whole point of the batch.

| | |
|---|---|
| **Goal** | An IDE-based agent (Cursor, Cline, Continue, Zed, Claude Code…) becomes a governed client of RegulAIt for **both** tool calls and model calls. |
| **Work items** | **(1)–(5) SHIPPED**: (1) `POST /v1/messages` — Anthropic-shaped shim over `executeGovernedDispatch`, incl. SSE streaming and content-block/tool_use round-tripping. (2) `POST /v1/chat/completions` — OpenAI-shaped shim over the same core. (3) The three-mode resolution policy above + admin UI. (4) The admin "Client Access" tab emitting per-tool copy-paste config (base URL, key, MCP entry). (5) `docs/product/IDE_INTEGRATION.md` for the MCP path that already worked. **(6) NOT shipped**: OTel ingestion (observe-rung) — now homed in §6. |
| **Files** | `apps/gateway/src/compat-anthropic.ts`, `compat-openai.ts`, `compat-core.ts` (+ `ide-interception.test.ts`, 46 tests); `agents-connectors.ts` (reuse only); `schema.ts` + migration 0037 (`interception_settings`); `admin-portal.ts` (Client Access tab); `shared/src/index.ts` |
| **Migration?** | **Done** — 0037 |
| **Size** | Was **L**; landed in one batch plus the `fdfeff1` temperature amendment |
| **Risk / deps** | The compatibility surface has a **long tail** — `tool_choice`, thinking blocks, structured outputs, prompt caching headers, `anthropic-version` negotiation. The shipped subset fails loudly (400 naming the field) on the unsupported rest, exactly as the provider registries do — with one deliberate exception: `temperature` is accepted-and-disclosed (ADR-0020 §5, `fdfeff1`) because rejecting it broke real clients. The remaining long tail is homed in §6. |
| **Coverage caveat — state this honestly, do not oversell** | Base-URL override is cleanly supported by Continue, Cline, Roo, Zed and Claude Code (`ANTHROPIC_BASE_URL`); Cursor takes an OpenAI-compatible endpoint. **GitHub Copilot is largely locked down** and would need its enterprise proxy path or nothing. **Eclipse** has no first-party AI agent of note — its ecosystem is third-party plugins, each with its own (often absent) configurability. "Works with every IDE" would be a false claim. |
| **Worth doing?** | **Done — it was the highest-leverage unbuilt item in the roadmap and it shipped the day it was raised.** The reasoning stands as the record of why it jumped the queue: breadth batches add vendors to a surface developers may never touch; this batch put the surface where the developers already are, and it makes the *existing* pillars pay off retroactively — every completion it intercepts is instantly attributed (5), optimized (6), PII-checked (3) and audited (1) with no further work. |
| **Doc debt it creates** | `CLAUDE.md` and `VISION.md` promise governance over "every agent/model, connector, and MCP-server-tool call" — written on the assumption that calls arrive at our gateway. Now that this batch has shipped, that claim needs restating as an explicit **interception** story, and this becomes a pillar-level concern rather than a feature. **Still flagged, still not edited — owner's text.** |

---

## 4. Recommended order, and what can run in parallel

### Order

```
  (MERGED: governance-gaps batch — revocation, MCP attribution+PII, streaming suppression,
   data_sensitivity — PR #44, migration 0036, ADR-0019)
        │
   1.  BATCH E (hygiene)          ── do first, it is cheap and it protects everything after
        │                            └─ CI revert the moment minutes exist; STATE.md accuracy pass
   2.  BATCH G (Anthropic key)    ── the moment the owner has it; zero engineering, maximum demo delta
        │
   3.  BATCH H (IDE interception) ── SHIPPED 2026-07-30 (migration 0037, ADR-0020 + fdfeff1).
        │                            Promoted and landed the same day it was raised; follow-ons
        │                            (OTel rung, per-role/project overrides, compat long tail,
        │                            key-custody/network rungs) are homed in §6.
        │
   4.  BATCH D (depth & polish)   ── best value/risk; pick a subset, see the serialization rules
        │
   5.  BATCH B (connectors)       ── only the kind you can actually demo (Slack first)
        │
   6.  BATCH A (git breadth)      ── only when a real non-GitHub repo is named
        │
   7.  BATCH C (infra/BYOC real)  ── needs a named account + explicit sign-off
   6'. BATCH F (production)       ── needs the owner's explicit in-session go-ahead; not schedulable otherwise
```

**Why this order.** E and G are near-free and compound (E protects the merge gate; G makes
every subsequent demo real). D closes documented promises inside code that already has tests —
the lowest chance of a nasty surprise. A, B and C all add *new external surface area*, and each
one is best justified by a named target rather than by the principle in the abstract. F is not
ours to schedule.

### Parallel vs serial — the hard-won rule

**Safe to parallelize** (separate package files, no shared state):

| These can run at the same time | Because |
|---|---|
| Batch A (`packages/git-provider/`) | own package, own test file |
| Batch B (`packages/connector-provider/`) | own package, own test file |
| Batch C infra adapters (`packages/infra-provider/`) | own package, own test file |
| Batch D's model-provider items (Responses API, tool-use nuances) | own package |
| Batch E's CI/doc items | not code |

**Must be SERIAL — one at a time, merged before the next starts:**

| Shared file | Who touches it |
|---|---|
| `packages/db/src/schema.ts` + `packages/db/migrations/` **incl. `meta/_journal.json`** | compaction dials, `agents.systemPrompt`, ADR-0015 A4, any connector-credential reshape |
| `apps/gateway/src/admin-portal.ts` (1603 lines) | every admin-UI item across D and A |
| `apps/gateway/src/app-ui.ts` (2628 lines) | every end-user-UI item |
| `apps/gateway/src/orchestration.ts` (2002 lines) | worker-node streaming, any pillar-7 work |

**The lesson, stated plainly:** builds that share `schema.ts`, a migration, or either single-file
UI **must be serialized**. Two agents editing a 2600-line template-literal UI file produce
merge conflicts that are painful to resolve and that `tsc` will not catch (the inline JS in
those files is a string as far as the compiler is concerned — which is exactly why
`scripts/check-ui-syntax.mjs` exists; run it).

**And: each migration must own a distinct number.** The highest applied is **0037**
(`0037_interception_settings.sql`); the next free is **0038**, and **0038 is being claimed by
the org-settings batch in flight** — any batch scheduled after it must **check the directory
first**, not assume. Two parallel branches both writing the same `00NN_*.sql` is a silent, ugly
failure — the second one to merge never runs. **And the directory is not even the real
chokepoint: `packages/db/migrations/meta/_journal.json` is.** Drizzle's `migrate()` reads the
journal, not the directory — so two branches with perfectly distinct filenames still conflict in
the journal's entries array, and a bad journal merge (dropped or mis-ordered entry) makes
`migrate()` silently skip a migration with no error at all. Treat `_journal.json` as a
serialized, merge-with-eyes-open file exactly like `schema.ts`.

**Branch discipline** (adopted in session 02): branch-per-PR, so the mobile app's PR chip
tracks the current PR rather than an old merged one.

---

## 5. Decisions the owner needs to make

These are genuine forks. The answer changes the plan; I am not pre-deciding them except where
noted.

**0. How far up the interception ladder does RegulAIt intend to go?** *(added 2026-07-30, and it
now outranks the rest)*
Batch H's table has six rungs. The product's honesty depends on naming the target rung out loud.
*Voluntary* (developer points their IDE at us) is a fine v1 and costs one shim — but it is an
honor system, and an enterprise buyer will ask what stops a developer from just… not. *Key
custody* is the cheapest real answer and is almost entirely policy rather than code: the org holds
the vendor keys, developers hold RegulAIt keys, and bypassing means having no key at all. *Network
egress* is the airtight answer and is a genuine infrastructure project that belongs with BYOC.
**Trade-off in one line: how much of the enforcement story is our code versus the customer's IT
policy — and are we willing to say so plainly in the pitch?**

**1. Is provider breadth needed speculatively, or only on demand?**
*Option A — build it now:* the `CLAUDE.md` principle becomes literally true, and a prospect
asking "do you support GitLab?" gets a yes. Cost: ~7 adapters (3 git + 4 connector) built
against fake servers, none validated against a real tenant, all of them permanent maintenance
surface. *Option B — build on demand:* each adapter is roughly an afternoon once a specific
target exists, and it gets validated against the real thing. Cost: the honest answer today is
"the interface is ready, the adapter isn't" — which is defensible engineering but a weaker
sales answer. **Trade-off in one line: credibility now vs. validated integrations later.**

**2. Does the dev stack ever become production?**
This is the guardrail conversation. If **no** (it stays a demo box forever), then Batch F
collapses to two hygiene items — backed-up Postgres and getting `REGULAIT_DATA_KEY` off the
instance — and everything else is dropped. If **yes**, it needs its own ADR, an explicit
sign-off, and probably a separate AWS account, and it becomes the largest single body of work
in this roadmap. **A Claude session cannot start this on its own; it needs the owner's words.**

**3. SPA rewrite, or keep the single-file portal?**
ADR-0012 deliberately chose one dependency-free HTML+JS file with zero toolchain — an explicit
supply-chain argument in a governance product ("no React/Vite dependency tree to govern"). That
file is now 1603 lines and is the #1 serialization chokepoint in §4. *Keep:* zero deps, zero
build step, the ADR's reasoning still holds, and the recent `dataTable()`/`UI_TABLE_JS`
refactor bought real runway. *Rewrite:* unblocks parallel UI work and the deferred SCIM/SIEM/
bulk-action surfaces. **My read, offered as a read and not a decision: keep it for now.** The
ADR's condition was "until the portal outgrows a single file," and the shared-helper extraction
means it hasn't yet. Revisit if a second person ever works on the UI simultaneously.

**4. Which pillar-3 half matters more — governed operations, or real cloud execution?**
The governed spine is done and demos keylessly. Real execution has blast radius and needs a
named account. If pillar 3's story is "we govern infra operations", Batch C can wait
indefinitely. If the story is "we patch your CVEs", it can't. **These are different products;
worth being explicit about which one is being sold.**

**5. Should unimplemented providers be creatable at all?**
Today `git_connections` accepts `gitlab` at creation and fails at execution (sharp edge #1,
§2). *Keep:* forward-compatible; the connection row is ready the day the adapter lands.
*Narrow:* the failure moves to creation time, where an admin can actually understand it.
**One option is clearly better here: narrow it, or at minimum badge it in the admin UI.** A
governance product should not let an admin configure something that cannot work.

**6. Is there anything the owner wants that is not in this document?**
This roadmap is assembled from what the repo and STATE.md say is unfinished. It contains no
*new* product ideas. If the direction is now "make one pillar excellent" rather than "even out
all eight", the batch structure above is the wrong shape and should be rebuilt around that.

---

## 6. Orphaned deferred items — batch-homed so they are never lost

*(Added 2026-07-30 by the doc-reconciliation review; the table is appended to as new deferrals
appear — sixteen at the time of writing.)* These deferrals are each recorded
somewhere — an ADR consequences section, a STATE.md addendum, a spec — but before this section
none of them had a home in any batch above, which is exactly how deferrals die. One line each;
the cited source holds the detail. This is an index, not a commitment to build any of them.

| # | Item | Where it was deferred | Batch home |
|---|---|---|---|
| 1 | Reapply-on-reclassification — re-running the compliance cascade over in-flight workflow instances when a project's tag changes (today: diff covers policy only, in-flight instances keep merged definitions) | compliance-cascade addendum (STATE.md) | **D** |
| 2 | Per-framework cost policies — compliance frameworks driving cost/budget defaults, not just workflow/scope/retention/PII | compliance-cascade addendum (STATE.md) | **D** |
| 3 | SCIM team sync (and SSO status surface — no backend at all today, grep finds zero references) | ADR-0012 §4; Shared-Projects addendum | **D** (admin-portal serial) |
| 4 | Rule *exemptions* object — cross-scope override for scoped policy rules, rejected in v1 because it widens | rule-scoping slice (migration 0026, STATE.md) | **D** |
| 5 | Backup **scheduler** — `backup_runs` ledger exists, nothing actually schedules runs | ADR-0017 | **C** |
| 6 | Cert-rotation **lifecycle** — rotation verbs exist; no expiry-driven auto-proposal loop | ADR-0017 | **C** |
| 7 | PM drift auto-resolution — drift is detected + surfaced, resolution is manual | pillar-8 slices (STATE.md) | **D** |
| 8 | PM budget-approval mirroring — budget escalations don't mirror into the PM tool as linked records | pillar-8 slices (STATE.md) | **D** |
| 9 | Partial revocations — revocations are total; "read-only from now on" means editing the grant | ADR-0019 consequences | **D** |
| 10 | Per-tool MCP pricing — price is flat per call on the *server*; an additive per-tool column when a customer needs it | ADR-0019 consequences | **D** |
| 11 | ~~Docs honesty: unattributed MCP calls are unmetered/unenforced~~ **SHIPPED 2026-07-31 (ADR-0024)** — every MCP call is now metered (null-project rows land in an explicit Unattributed bucket), `require_mcp_attribution` closes the gap outright, and the docs state the now-true claim | ADR-0019 consequences → ADR-0024 | **done** |
| 12 | OTel ingestion (the interception ladder's *observe* rung) | Batch H work item (6), unshipped | **H follow-on** |
| 13 | ~~Per-role/per-project interception-setting overrides~~ **SHIPPED 2026-07-31 (ADR-0024)** — `interception_scope_rules` (user > project > role > org, first non-NULL per field, most-recent wins in-kind; exposure ≠ entitlement; 404 stays indistinguishable), admin CRUD + live effective-value preview | ADR-0020 → ADR-0024 | **done** |
| 14 | Compat long tail — `tool_choice`, thinking blocks, structured outputs (today: loud 400s; `temperature` alone is accept-and-disclose) | ADR-0020 §5 | **H follow-on** |
| 15 | ~~`key_custody` + `network` enforcement rungs — declared, not enforced~~ **key_custody SHIPPED 2026-07-31 (ADR-0024)** — `key_custody_enforced` makes BYO user credentials 409 + inert at dispatch (reversible), posture UI labels enforced-vs-declared honestly; `network` documented as an egress-allowlist recipe in IDE_INTEGRATION.md (infra-level by nature — product-side portion done; the actual egress control remains a Batch C/BYOC infra concern) | ADR-0020 / Batch H ladder → ADR-0024 | **done** (product side) |
| 16 | Deeper a11y — beyond the shipped contrast/focus/aria-live pass (full keyboard-nav audit, screen-reader flows) | UX/a11y pass (STATE.md addendum 33) | **D** |
| 17 | ~~Login by **user ID / username** instead of email~~ **SHIPPED 2026-08-01 (ADR-0030)** — nullable+unique `users.username` (migration 0047) whose CHECK forbids `@`, making the username and email namespaces provably disjoint so one login field resolves both ('@' ⇒ email, else username) with no impersonation path; case-insensitive by construction (lowercase-only storage, normalize-on-write); `{email, password}` still accepted so every shipped client keeps working; ADR-0025's uniform 401 (status, body AND scrypt cost) holds across the new namespace; admin-managed by default with an `org_settings.username_self_service` opt-in; OIDC deliberately still maps on verified email | owner request 2026-07-31 (ADR-0028 session) → ADR-0030 | **done** |

---

## 7. ISACA — *Cybersecurity Recommendations for Securing AI Agents* (2026)

*Added 2026-09-25 at the owner's request: read the paper, say what we can take from it, and put it
on the roadmap rather than building it now. Nothing below is committed.*

**Why this document is worth taking seriously.** It is not a framework we would have to contort the
product to fit. Its 11 practice categories are close to a description of what this product already
is — a deterministic policy enforcement point between agent outputs and action-capable systems,
with human approval for high-risk actions and a tamper-resistant ledger. Two of its controls read
almost as our own design notes: *"do not let retrieved content directly trigger actions without a
separate policy decision"* and *"implement a deterministic PEP … validating action type, target
system, actor identity, authorization, business rules, risk thresholds, and required approvals."*

That cuts both ways. Where we do **not** match it, the gap is conspicuous precisely because the rest
lines up — and a security-led buyer (which Reynolds is) will read this paper.

### 7.1 Honest self-assessment against the 15-item Secure-by-Default checklist

Audited against **enforcing code**, not ADRs. Anything that could not be traced to code that runs is
marked accordingly.

| # | Checklist item | Us | Note |
|---|---|---|---|
| 1 | Inventory agents, tools, models, memory, providers | **Partial** | `GET /v1/inventory/*` covers agents, connectors, MCP servers, grants, providers, vendors, use cases, risks, and splits *granted* from *observed*. **Memory stores are not inventoried at all.** |
| 2 | Trust boundaries and owners | **Partial** | Owners exist on agents, risks, vendors, use cases. Boundaries are implicit (deploy mode, project cascade, egress allow-list); no first-class object, and MCP servers/connectors have no owner. |
| 3 | Per-agent identity, least privilege | **No, as specified** | Least privilege is real but **per-human**. `tool_grants` is `(userId, serverId, toolName)`; the ABAC schema has only a `User` principal. An agent's effective permission is the union of its grant-holders'. |
| 4 | Short-lived credentials, federated identity | **Partial** | Real STS for customer cloud infra; expiry primitives on API keys, virtual keys, sessions, approvals. **No federated workload identity for agents**; model-provider credentials are long-lived stored keys. |
| 5 | Sandbox execution, network segmentation | **No (sandbox)** | We proxy to remote MCP servers; nothing executes tools locally, so there is no sandbox to speak of — and also no local execution risk. Network side is one flat compose network and a wide-open Terraform egress rule. |
| 6 | Deny outbound by default | **Yes** (application layer) | The egress guard: default-deny allow-list, no wildcards, resolved-address range blocks, IMDS carve-out, redirect refusal, DNS-rebind closed. Enforced at write time *and* every dispatch. Process-level egress is still open. |
| 7 | Treat retrieved content and tool output as untrusted | **Partial** | A prompt-injection detector runs at **runtime** on MCP tool arguments *and output*, and on agent input/output. But it ships in `log` mode, does not see conversation history, system prompts or shared context, and there is **no provenance/trust-level tagging and no instruction-hierarchy enforcement**. |
| 8 | Memory isolation and retention | **Partial** | Isolation is good (cache scoped per user+agent, conversations own-scoped, project context membership-gated). **Retention is not enforced** — the cache TTL is a read-time filter with no purge job, and conversations have no sweeper. |
| 9 | All tool actions behind a PEP | **Yes** | One choke point: `governedEvaluate` → the policy kernel. Entitlements, ABAC, approvals, rate limits, data scopes, budgets, PII, guardrails, admission, plan-only. |
| 10 | Human approval for high-risk actions | **Partial** | Strong core: payload-bound consent, policy-bound consent with TTL, atomic single-winner consume, SoD. **Missing: dual control** (tool-call rules name one approver) **and step-up re-auth** (MFA is a login-time session attribute). |
| 11 | Log prompts, tool calls, decisions, approvals with redaction | **Yes** | Hash-chained ledger, WORM anchoring graded by asking the bucket, credential scrub at the DB chokepoint over 53 declared prose columns. *(The one hole found — an unaudited agent enable/disable — was closed in ADR-0123.)* |
| 12 | Pin models and dependencies; SBOM; signing | **Partial — our weakest** | Ed25519-signed update bundles with verify-before-apply is real. **No SBOM or AI-BOM, no image signing, no digest-pinned base image, and no model version/endpoint pinning** (`agents.model` is a free-form string). |
| 13 | Secure SDLC and change control | **Split** | *In-product* change control is strong (immutable versions, canary, rollback, policy dry-run, workflow gates). *Our own* CI runs build/typecheck/test only — no SAST, dependency, secret or container scanning. |
| 14 | Kill switches, rollback, safe mode | **Partial — no kill switch** | Rollback is real. **There is no kill switch**: no global stop, no per-tool emergency disable. The nearest thing is a per-agent `enabled` flag (enforced in the kernel, now audited). **No read-only or recommendation-only mode** at agent or deployment scope. |
| 15 | Continuous red teaming | **Yes — our strongest** | Versioned attack libraries including indirect prompt injection, multi-turn sequences, an adjudicator that asks the kernel what it *would* decide and executes nothing, a scheduled daily sweep, regression gating, evidence onto model cards. |

**Score, stated plainly: 4 full, 9 partial, 2 absent.** For a product this young that is a good
result, and the two absent ones are both in category 11 (*Reliability, Resilience, Kill Switches*) —
the one category we have barely touched.

### 7.2 What to build, ranked

Ordered by *buyer-visible gap × cost to close*, not by how interesting it is.

| # | Item | Why | Rough size |
|---|---|---|---|
| **I1** | **Kill switch + safe mode.** A global stop, a per-agent and per-tool emergency disable, and a deployment-wide read-only/recommendation-only mode. Audited, reversible, reason-required, surfaced on the posture page. | The single most conspicuous absence for a governance product, and the one a CISO asks about first. ISACA lists it twice (checklist 14, category 11). We already have every primitive — `enabled`, `plan-only`, connector `read` mode — but nothing that reads as an emergency control. | **M** |
| **I2** | **An ISACA compliance pack.** The 15-item checklist is almost exactly the shape of a pack: one control per item, `collector` where we can evidence it, `attestationRequired` where it is organisational. | Cheapest credibility in the list — the machinery exists (ADR-0058), and §7.1 shows most controls would evidence themselves. It also makes our own gaps visible on our own dashboard, which is the right pressure. | **S** |
| **I3** | **Memory retention that actually runs.** A TTL/purge sweep for `semantic_cache` and a conversation retention policy, driven by the existing scheduler. | We *declare* retention and do not enforce it. `semantic_cache` holds prompts and outputs and is never deleted — a privacy finding waiting to be written up, and ISACA calls it out explicitly. | **S/M** |
| **I4** | **Content provenance and trust levels.** Tag retrieved content and tool output with a source trust level, and refuse to let low-trust content carry high action authority. Plus an instruction-hierarchy boundary so external content cannot override system instructions. | ISACA's category 5 in one line, and the thing our injection detector cannot do: it pattern-matches text rather than tracking where the text came from. This is a real differentiator, not just a gap-filler. | **L** |
| **I5** | **SBOM / AI-BOM, image signing, model pinning.** CycloneDX in CI, cosign on the image, digest-pinned base, and a pinned model-version concept beside the free-form `agents.model`. | Supply chain is our weakest row and the easiest to be embarrassed on: a buyer asks for an SBOM and we have none. Model pinning also closes a real governance hole — a provider can change what `gpt-5` means underneath an approved model card. | **M** |
| **I6** | **Dual control and step-up auth.** Quorum on tool-call approval rules (workflow stages already have it), and a re-authentication challenge at the sensitive action rather than a login-time MFA attribute. | ISACA asks for both explicitly for destructive/financial/irreversible actions. We have the approval machinery; this is an extension of it rather than a new subsystem. | **M** |
| **I7** | **Per-agent identity.** An Agent principal in the ABAC schema, with its own entitlements rather than the union of its grant-holders'. | The most architecturally significant item here and the one we should be slowest about — it touches the kernel. But "least privilege for agents" is not a claim we can make today, and ISACA's category 3 is entirely about it. | **XL** |
| **I8** | **Our own security CI.** SAST, dependency, secret and container scanning on the repository. | Not customer-facing, but it is checklist item 13 and we would fail our own pack. | **S** |
| **I9** | **Memory-store inventory and connector/server ownership.** Extend the inventory to memory stores; add owners to MCP servers and connectors. | Closes checklist items 1 and 2 to *full*, cheaply. | **S** |
| **I10** | **Data classification handling matrix** (ISACA Appendix A). Its Store/Send/Access/Keep/Dispose verbs per classification tier map onto our compliance-profile cascade, which already drives retention and PII mode. | Would let a compliance profile express handling rules in a vocabulary an auditor already knows. | **M** |

### 7.3 Two things to change in how we *talk*, not what we build

- **Do not claim "least privilege for agents."** We enforce least privilege for the *humans* who
  hold agent grants. Until I7, the accurate sentence is "every agent call is bound to an entitled
  human identity" — which is a strong claim, and a different one.
- **The injection detector should be described as a detector, not a defense.** It runs at runtime on
  tool arguments and output, which is more than registration-time scanning — and it ships in `log`
  mode with no provenance model, which is less than a defense. Both halves, or neither.
