# Pilot readiness: the four success criteria traced through the code

- **ADR**: [ADR-0326](../decisions/0326-pilot-readiness-audit-and-live-harness.md) (lane E11)
- **Audited**: `main` at `26d16126a127646d76d6649a75c656e858a9c629` and the open PRs on 2026-11-15
- **Pilot stack**: Entra ID (SSO, SCIM); Azure DevOps Boards and Repos; GitHub Copilot, Cursor, Claude Code and OpenAI
  Codex/ChatGPT; Anthropic, OpenAI, AWS Bedrock and Google Gemini/Vertex; BYOC in the customer's AWS account.

Each gap has an ID. **Owner** is the lane or PR that covers it, **this PR** when E11 fixed it, or **unowned** when no
lane has it. The master assigns the unowned rows. The live harness (`apps/gateway/live/`, see
[LIVE_TESTS.md](../../docs/deployment/LIVE_TESTS.md)) carries a `todo` for each gap it would test, so a run shows
them.

## Summary

| Criterion | On main today | Verdict |
|---|---|---|
| 1. A blocked MCP server or model is blocked in all four tools, with an audit record | Blocked in the gateway for any tool that routes through it (Claude Code; Cursor and Codex if configured). Not for Copilot model calls. Not for an MCP server a developer adds locally. | **Not met** |
| 2. Per-user and per-project spend across tools and APIs within minutes, with a budget alert firing | Real time for gateway traffic to Anthropic, OpenAI and Gemini, with an alert in the audit log and Approvals Queue. No Bedrock, no Vertex, no tool-side spend, no pushed alert. | **Partly met** |
| 3. One Boards work item: plan sign-off → agent build → Repos PR → checks → approval, governed and audited | Both ends work (inbound webhook, plan gate, branch, PR, merge, write-back). The middle is missing: nothing starts a run from a work item, no agent commits code, ADO checks and votes don't gate. | **Not met** |
| 4. The customer installs BYOC from the runbook in under a day | Feasible on one host with Docker Compose (`scripts/install.sh --mode byoc`). There is no AWS-specific runbook, and the Kubernetes path is unmerged. | **Met on Compose, with gaps** |
| Identity (needed for 1 to 3) | OIDC, SAML and SCIM 2.0 are built. A direct Entra OIDC login was refused (fixed here). Entra's default SCIM mapping fails on update. | **Partly met** |

## Identity: Entra ID SSO and SCIM

**Works on main**

- OIDC relying party with code and PKCE (`apps/gateway/src/auth.ts`). Admins manage providers at
  `/v1/auth/oidc-providers`. Providers are database rows, and the issuer must be on the egress allow-list.
- SAML (`saml.ts`).
- SCIM 2.0 Users and Groups (`scim.ts`):
  - hashed bearer tokens with a rate limit per token
  - `Replace`-cased ops, the path-less `{active:false}` and `emails[type eq "work"]` are handled
  - group-to-role mapping is default-deny (`group-roles.ts`)
  - SCIM is a licensed feature, closed when no license is installed
- Entra through the bundled Keycloak broker (`docs/deployment/SSO_KEYCLOAK.md`).

| ID | Gap | Owner |
|---|---|---|
| G0-1 | A direct Entra OIDC login was always refused. The callback demanded `email_verified: true`, which Entra never sends; Entra sends `xms_edov`. **Fixed:** `xms_edov: true` is accepted only from the tenant's own v2.0 issuer with a matching `tid` (`src/oidc-email-verified.ts`). The app registration must request the `email` and `xms_edov` optional claims ([ENTRA_ID.md](../../docs/deployment/ENTRA_ID.md)). | this PR |
| G0-2 | Entra's default SCIM attribute mapping fails on update. A create with `name`/`title` is accepted (and those fields ignored), but a PATCH of `name.givenName`, `title` and similar is a 400. Live test `entra-sso-scim.live.test.ts` pins today's behaviour. **Workaround:** trim the mapping to userName, active, displayName, emails and externalId (ENTRA_ID.md). **Fix:** accept, and ignore or store, the core User attributes Entra sends. | unowned |
| G0-3 | Entra sends groups as object-id GUIDs, so the group-role mapping must use GUIDs. A token with more than 200 groups (the `_claim_names` overage case) is not handled. | unowned |
| G0-4 | Entra-driven provisioning needs a gateway Entra can reach. The harness carries a `todo` that runs it once `REGULAIT_LIVE_PUBLIC_GATEWAY_URL` exists. | unowned (needs a reachable dev gateway) |

## Criterion 1: block a model or MCP server in all four tools

**Works on main**

- **Model blocks.** The admin model policy (`model-policy.ts`), the kill switch and revocations run inside
  `prepareCompatCall` (`compat-core.ts`) for `/v1/messages`, `/v1/chat/completions` and `/v1/responses`. A deny is a
  403 with an audit row.
- **MCP blocks.** A disabled server registered in RegulAIt is refused at `POST /mcp/:serverId` with a deny audit row
  (`mcp-proxy.ts`; test `integration-lifecycle.test.ts`).
- **Claude Code:** `ANTHROPIC_BASE_URL` plus `claude mcp add` through the proxy
  (`docs/product/IDE_INTEGRATION.md`).
- **On-device hook.** ADR-0298 built a Claude Code PreToolUse enforcement hook (`agents/endpoint/internal/enforce/`)
  that fails closed. It is not active yet (see G1-3).

| ID | Gap | Owner |
|---|---|---|
| G1-1 | A model "blocked" by disabling or unmapping its agent returned 403 `model_not_mapped` / `agent_not_resolvable` with **no audit row**. **Fixed:** one deny row each (`compat-core.ts`; test in `ide-interception.test.ts`). | this PR |
| G1-2 | No managed settings are generated or pushed: Claude Code `managed-settings.json` with hook registration and `deniedMcpServers`, Cursor and VS Code/Copilot MCP policy, Codex `config.toml` `base_url`. Without them, routing through RegulAIt is voluntary. | E1 (no PR yet) |
| G1-3 | A locally configured MCP server is only inventoried, never blocked. The ADR-0298 hook has an empty `CompiledKeyring` (so a registered hook denies every MCP call), nothing registers it, and it writes **no audit record** to the gateway. Cursor, Copilot CLI and Codex adapters are future work. | partly E1; hook audit reporting and the signer key are unowned |
| G1-4 | GitHub Copilot model calls go to GitHub's backend and cannot be redirected. Only Copilot's MCP traffic can be governed, plus GitHub's own org policies, which are not RegulAIt's control and leave no RegulAIt audit. The pilot needs an owner decision: accept "MCP only" for Copilot, or ingest GitHub's audit and usage data as evidence. | unowned (owner decision) |
| G1-5 | Codex has no runbook (`config.toml` `model_provider`/`base_url`/`wire_api = "responses"`), is missing from the IDE_INTEGRATION.md matrix, and has no client-compat test. `/v1/responses` exists and denies correctly. | unowned |
| G1-6 | Cursor sends no custom headers on model calls, so with the default `requireProjectAttribution` every Cursor completion is a 400 until an admin relaxes it. Needs a key-pinned default project for IDE keys, or a documented virtual key per project. | unowned |
| G1-7 | Not tested against the real Cursor or Codex clients (only the official SDKs and Laravel in `client-compat/`). | unowned |

## Criterion 2: spend per user and per project, within minutes, with a budget alert

**Works on main**

- **Providers:** `anthropic`, `openai` and `google` (Gemini through the AI Studio API key) in
  `packages/model-provider`.
- **Cost rows:** every gateway call writes a `usage_events` row with user, project, provider, model, tokens and cost,
  synchronously (`agents-connectors.ts`). `GET /v1/usage-events/summary` reads it live, so spend is visible in seconds.
- **Budgets:**
  - the call after the cap is hard-blocked (`preDispatchProjectGate`)
  - the threshold alert is an audit row `budget-threshold-alert`
  - an overage escalates into the Approvals Queue (`postDispatchProjectAlert`)
  - tests in `mcp-proxy.test.ts`
- **Live check:** the harness exercises all of the above against the real Anthropic, OpenAI and Gemini APIs
  (`models-cost-budget.live.test.ts`).

| ID | Gap | Owner |
|---|---|---|
| G2-1 | No native Bedrock inference: no SigV4 and no IAM role or assume-role signer. Bedrock appears only as a training backend and in discovery. | unowned |
| G2-2 | No Vertex AI inference. Google model calls are API-key only, with no service-account or workload-identity auth. | unowned |
| G2-3 | No maintained vendor price table. Cost is whatever an admin typed into each agent, and nothing keeps it in sync. | unowned |
| G2-4 | Budget and threshold alerts are not pushed anywhere: no email, Slack, Teams or webhook. `notifyGovernanceAlerts` (`chatops.ts`) is not called from budget paths, and no test shows an alert delivered. | unowned |
| G2-5 | The usage summary groups by agent, connector, MCP tool, project and day, but not by user. Per-user spend needs one request per user. | unowned |
| G2-6 | Spend from tools that bypass the gateway (Copilot and Cursor seats and usage, vendor consoles) arrives only by manual CSV upload (`cost-import.ts`). It is never near real time and never counts against budgets. | E7 #845 (design only so far) |
| G2-7 | Cost per outcome. | E2 #848 |
| G2-8 | The spend-anomaly sweep is hourly. Only the inline budget check is real time. | unowned (a setting, probably fine) |

## Criterion 3: one Boards work item, end to end

**Works on main**

- **Inbound ADO service hooks:**
  - Basic-auth password per connection, compared in constant time
  - replay protection by `createdDate` window and delivery key
  - code: `pm-provider/src/inbound.ts`, `pm.ts`, `pm_webhook_deliveries`
- **Workflow kernel:**
  - the plan-only stage rests at `blocked_on_plan`
  - sign-off is an artifact plus a `human_approval` stage
  - templates are assigned by rule
- **Azure Repos** (`git-provider/src/azure-devops.ts`):
  - branch, PR, statuses, merge by completion
  - each git effect is audited
  - a merge from a stale round is refused
- **Write-back to the work item:** the approval decision updates state and adds a comment (`mirrorApprovalDecision`).
  Drift is detected and audited.
- **Live check:** the harness exercises Boards and Repos against a test organization, through the product's adapters
  (`ado-boards-repos.live.test.ts`).

| ID | Gap | Owner |
|---|---|---|
| G3-1 | A `workitem.created`/assigned service hook does not start a workflow instance. `processInboundEvent` records the event and stops when no link exists. | L6 "ADO assignability" (no PR yet) |
| G3-2 | An existing work item cannot be bound to an instance. `pm-sync` only creates a new work item from RegulAIt. | partly L6 #828 (importer); otherwise L6 assignability |
| G3-3 | No agent writes code. `GitProvider` has no commit or push, so `create_branch` cuts an empty branch, and `automated_build` runs model nodes, not a coding agent. | partly E5 #847 (cloud coding agents as governed workers); the commit primitive is unowned |
| G3-4 | ADO PR checks don't gate the workflow (`listChecks` has no gateway caller), and RegulAIt posts no status back through the ADO Status API. | unowned |
| G3-5 | ADO reviewer votes and branch policies are not reflected in the merge gate. Only RegulAIt's own approval counts. | unowned (L1 approvals is adjacent) |
| G3-6 | ADO auth is PAT only. An enterprise tenant will expect an Entra service principal or workload identity. | unowned |
| G3-7 | The PR description carries no `AB#<id>` link to the work item, so ADO shows no link. | unowned (small) |
| G3-8 | No gateway-level end-to-end test covers ADO. | this PR adds the live adapter run; the governed run needs G3-1 to G3-3 |

## Criterion 4: BYOC install from the runbook in under a day

**Works on main**

- The runbook is `docs/deployment/INSTALL.md` with `scripts/install.sh --mode byoc`: a preflight, a `--check` dry
  run, a deterministic render, an air-gapped bundle and a first-admin prompt. It is roughly 13 steps on one host.
- Images are cosign-signed and published by `publish-image.yml`.
- The operator (`deploy/operator/`, ADR-0304) is on main.

| ID | Gap | Owner |
|---|---|---|
| G4-1 | No AWS-specific BYOC runbook or customer Terraform: VPC, EC2 sizing, RDS, IAM, DNS/TLS. `infra/modules/app-instance` is dev-grade and builds from a source tarball. | unowned (E10/L12 if that lane takes it) |
| G4-2 | The Helm chart is unmerged. | L12 #817 |
| G4-3 | `operator.yml` builds the operator image but never publishes it. | unowned |
| G4-4 | The GHCR package starts private, so a customer needs a `read:packages` token or a public package. | unowned (owner decision) |
| G4-5 | INSTALL.md posted the IdP to `/v1/auth/oidc/providers`; the route is `/v1/auth/oidc-providers`. **Fixed.** | this PR |
| G4-6 | IdP wiring, egress allow-listing and backups are manual curl steps after install. | unowned |

## Unowned gaps, for the master

G0-2, G0-3, G0-4, G1-3 (hook audit and signer), G1-4 (owner decision), G1-5, G1-6, G1-7, G2-1, G2-2, G2-3, G2-4, G2-5,
G3-3 (commit primitive), G3-4, G3-5, G3-6, G3-7, G4-1, G4-3, G4-4 (owner decision), G4-6.

The larger ones are recorded as PENDING fragments under `internal/fragments/2026-11-15-e11-*`.
