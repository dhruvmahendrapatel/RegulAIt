# Gemini feedback — active gaps and compact closures

Cleaned 2026-10-03 at `dhruv/active` commit `64f0943f7fcc5d62332df29d42f0dbbea944beb0`, per the owner's request.
This is a cleanup of the existing verified ledger, not a new audit of every security roadmap item.
Open/partial evidence below retains its original 2026-10-02 baseline unless explicitly updated.
Do not interpret an unverified roadmap possibility as a proven defect or as authorized implementation.

[Complete original sweep, both verification appendices, status and fixing evidence](https://github.com/dhruvmahendrapatel/RegulAIt/blob/64f0943f7fcc5d62332df29d42f0dbbea944beb0/geminiInputs.md)
is preserved in Git. Superseded claims and repeated closed-item prose no longer live in the active file.
For the Agent / AI use-case Intake UX scan, see `codexInputs.md`. Rechecked 2026-10-03 at `b5e1da5`:
AER-051..055 are RESOLVED/DONE; AER-050 is PARTIALLY RESOLVED (remaining recovery/navigation tests and fixes).
That targeted scan does not close GEM-nc-1's broader UI coverage gap.

## Active gaps and decisions

| ID | Severity | Title | Status | Evidence | Remaining gap | Next |
|---|---|---|---|---|---|---|
| GEM-open-2 | n/a | Retry/backoff is the SDK's, not ours | PARTIAL | [App I #2] ADR-0128 `upstream-retry.ts` (d15a418): full jitter, deadline-bounded budget for MCP connect/listTools; tools/call single-attempt by design (ADR-0129); `zz-adr0128-upstream-retry.test.ts` (27) | Model dispatch still relies on SDK `maxRetries: 2` (`model-provider/src/index.ts:266,958,989,1064`): no RegulAIt policy, jitter or retry budget | owner |
| GEM-open-3 | n/a | Transparent MCP proxying; stdio/SSE transports | OPEN | [App I #3 / §1C] `mcp-proxy.ts` registers only ListTools (`:1656`) and CallTool (`:1728`); one route POST /mcp/:serverId (`:1489`); StreamableHTTPServerTransport only | No resources/*, prompts/*, stdio or SSE | owner |
| GEM-open-4 | n/a | YAML workflow authoring | OPEN | [App I #4] no yaml/js-yaml dependency in any package.json; workflow kernel is JSON/zod only | YAML serialization (small) | owner |
| GEM-open-5 | n/a | Conditional branching between stages | OPEN | [App I #5] `workflow-kernel/src/index.ts:83` has only the deployment `condition`; no outcome routing or sub-workflow stage | Branching not built | owner |
| GEM-s2-4 | n/a | Only 2 of 7 token techniques applied | PARTIAL | [§2 / §4 P6] routing + semantic cache on compat (ADR-0119); edit-vs-rewrite and compaction on native invoke (`agents-connectors.ts`, `compaction.ts`); lazy tool-loading in `mcp-proxy.ts` | Compat/IDE surface still 2 of 7; request batching is ESTIMATE-ONLY (`orchestration.ts:2387-2426` 'NEVER changes dispatch behaviour'), so Appendix I's 'all seven wired' overstates by one | owner (claude corrects the appendix wording) |
| GEM-sec3 | n/a | Shadow-AI scanning phases 1–3 | PARTIAL | [§3] `shadow-ai.ts:15-17` 'NO COLLECTOR … NONE SHIPS'; import-only sources (egress_log, code_scan, saas_export, self_reported) + MCP-config upload; disclosed in DEMO_SCRIPT:66 and Q&A #11 | Cloud/git scanners, endpoint agent, network-log LLM all unbuilt | owner |
| GEM-p7 | n/a | Wall-clock concurrent wave execution | OPEN | [App II P7] `orchestration.ts:2421` 'nodes still dispatch one at a time'; auto loop awaits dispatchRunNode serially (`:2524`) | Concurrent wave executor; per-provider concurrency and partial-failure semantics undecided | owner |
| GEM-p8 | n/a | PM-reported state driving the run machine | OPEN | [App II P8] `pm.ts:928` under prefer_pm 'the run state machine stays untouched' | Governance decision: may an external system move a governed run | owner |
| GEM-A1-tier | n/a | No model/external-tier guardrail detectors | OPEN | [App II A1 caveat] every registered detector is tier 'heuristic' (`shared/guardrails.ts:240/307/367/449/494`); `:102` says model/external are not wired | Model-backed classification tier | owner |
| GEM-A2 | n/a | Malware/URL scanning of MCP tool results | OPEN | [App II A2 NOT FOUND] no malware, URL-reputation or phishing code in `apps/gateway/src` or `packages/shared/src` | Not built | owner |
| GEM-B3 | n/a | Exact Data Match | PARTIAL | [App II B3] `semantic_dlp` custom_term dictionaries only (`guardrails.ts:92`, countTerms) | No corpus ingestion, hashed-record index or per-record match | owner |
| GEM-B4 | n/a | In-flight PII redaction/masking | PARTIAL | [App II B4] PiiMode 'redact' (`projects.ts:443`); MCP path ADR-0143 (`mcp-proxy.ts:508,628,1179`); connector path ADR-0145 (`agents-connectors.ts:4887-5306`); ADR-0140/0141 shared foundation | ADR-0137 still Proposed; model dispatch path throws on redact (`projects.ts:554`); public mode gated | owner |
| GEM-B5 | n/a | Source-code/API-key exfiltration classifiers | PARTIAL | [App II B5 NOT FOUND] the API-key half already shipped: `semantic_dlp` credential_material rules on input and output (`guardrails.ts:393-437`, since 27205e7), block-capable via `semanticDlpMode` (`schema.ts:3779`, default 'log'); ADR-0135 Proposed | No source-code/IP classifier; secret blocking is opt-in (default log); ADR-0135 undecided | owner |
| GEM-C6 | n/a | Real-time SIEM streaming | OPEN | [App II C6] only the pull export GET /v1/audit.csv; ADR-0135 Proposed 'no live SIEM sender'; Q&A #12 discloses | No push to Splunk/Datadog/Sentinel/LogScale | owner |
| GEM-C7 | n/a | SOAR webhooks on severe violations | PARTIAL | [App II C7] ADR-0162 posts governance alerts above a severity threshold to Slack/Teams (`chatops.ts:655-686`) | No generic outbound webhook/SOAR subscription; no repeat-violation auto-revoke/isolate | owner |
| GEM-D9 | n/a | ABAC network location, device posture | PARTIAL | [App II D9] 5a9cad2: ABAC schema v2 `context.clientIp` as Cedar ipaddr (`abac.ts:167-206`), populated from req.ip (`abac-principal.ts:69`) — network-location half done | Device posture deliberately unmodelled (`abac.ts:198`); needs a posture source | owner (gemini closes the network half) |
| GEM-E10-iso | n/a | ISO 27001 alignment | PARTIAL | [App II E10] ADR-0134 (09-30) iso-27001 partial evidence pack; `COMPLIANCE_PACK_FRAMEWORKS` (`compliance-packs.ts:72`); every mapping 'partial' with human attestation | No full Statement of Applicability or certification | owner |
| GEM-nc-1 | n/a | Section-5 web UI not audited | OPEN | [App II NOT CHECKED] no UI audit recorded; ADR-0144 effective-action review exists in Inbox/Queue/Workbench | Coverage gap of the Claude-authored appendix, not Gemini's claim | claude |
| GEM-nc-2 | n/a | Heuristic injection/jailbreak detector quality | OPEN | [App II NOT CHECKED] red-team corpus exists (`redteam.test.ts`); no precision/recall for prompt_injection/jailbreak; ADR-0135 covers secrets only | Detection quality unmeasured; needs an eval set | owner |
| GEM-nc-3 | n/a | SCIM against a real Entra/Okta tenant | OPEN | [App II NOT CHECKED] `scim.ts:109-114` routes exist; no live-tenant test | Needs a real tenant | owner |
| GEM-nc-4 | n/a | pm-provider outbound adapters | PARTIAL | [App II NOT CHECKED] six providers (AzureDevOps, Jira, Linear, Asana, Monday, GenericWebhook; `pm-provider/src/index.ts:329-1062`); `index.test.ts` (35) | No detailed outbound review; no live-tenant verification | claude (review); owner (tenants) |
| G8 | n/a | Credo parity checklist refresh | OPEN | [Board §3 G8; `CREDO_PARITY_CHECKLIST_2026-09-30.md`] 10-02 03:08 | Checklist updated; rows 44-48, 50, 53 moved to Partial; 51-52 updated; Missing rows named; GAIA private-preview noted | claude (validate) |

## Agent UX / Ease-of-Use Scan (2026-10-03)

The following feedback was collected from a code scan of the agent administration and builder surfaces (`apps/web/src/views/admin/integrations/AgentsPage.tsx` and `apps/web/src/views/builder/BuilderAgentEditorPage.tsx`):

| ID | Area | Issue / Feedback | Recommendation |
|---|---|---|---|
| UX-AG-1 | Fallback Chains | Immediate auto-save on every chain mutation (add, remove, reorder) in `FallbackChainCard` breaks consistency with the explicit "Save" buttons used in all other forms on the page (Register, Pricing, Policy, Prompt). | Add a staging state for the fallback chain with a unified "Save Chain" button, or clearly label the section to indicate immediate application. |
| UX-AG-2 | Custom Endpoints | If a bound custom endpoint is later disabled, the `RegisterAgentCard` dropdown may silently drop the selected value from the UI because it strictly filters `selectable = providers.filter(p => p.enabled)`. | Include the currently bound endpoint in the dropdown even if disabled (flagged as `(disabled)`), so the user sees the true state and isn't forced to overwrite it accidentally. |
| UX-AG-3 | Pricing Intent | Using a blank input to mean "unpriced" for custom models is heavily caveated in help text but still prone to user error (users instinctively enter `0` for free/self-hosted models). | Add an explicit "Unpriced / Self-hosted" toggle that disables the number inputs, converting the UX from a negative constraint ("don't invent a number") to a positive choice. |
| UX-AG-4 | Builder UI | `BuilderAgentEditorPage.tsx` is an empty scaffold (`<PageHeader title="Agent" />`). The entire agent builder experience (ADR-0172) is missing from the codebase. | Prioritize the implementation of ADR-0172; without it, agent creation and editing is heavily skewed toward basic admin catalog forms. |
| UX-AG-5 | Entitlements | Role-granted agents in `EntitlementCard` lack a direct navigation path to the Role management page to remove the grant. The tooltip merely tells the user to go there manually. | Convert the "granted by role" tooltip into a clickable action or add a direct link to the corresponding Role editor. |

## Compact resolved / withdrawn register — do not rebuild

| ID | Status | Capability / scope |
|---|---|---|
| GEM-open-1 | RESOLVED/DONE (prior audit) | Active MCP upstream health checking |
| GEM-s2-1 | WITHDRAWN | Not a full MCP proxy |
| GEM-s2-2 | RESOLVED/DONE (prior audit) | Rate limits per-process, not HA |
| GEM-s2-3 | RESOLVED/DONE (prior audit) | 'Self-verifying' export wording overstated |
| GEM-A1-base | RESOLVED/DONE (prior audit) | Injection/jailbreak block mode ships |
| GEM-D8 | RESOLVED/DONE (prior audit) | SAML SSO and SCIM ship |
| GEM-E10-soc2-hipaa | RESOLVED/DONE (prior audit) | SOC 2 / HIPAA packs ship |
| GEM-nc-5 | RESOLVED/DONE (prior audit) | Pillar 7 review/acceptance path dispatch |

The 2026-10-02 audit already verified these seven shipped items; this cleanup retains that provenance rather than inventing new tests.
Source spot-checks at 64f0943 agree: health probe scheduled at `apps/gateway/src/scheduler-jobs.ts:455` (scheduler opt-in);
SQL-backed `SharedRateLimitStore` at `app.ts:655-671`; externally pinned export trust at
`scripts/verify-export-bundle.sh:74-76`; SAML/SCIM registration at `app.ts:3908-3918`;
SOC 2/HIPAA pack identifiers at `packages/shared/src/compliance-packs.ts:73-76`.
Exact-head CI `37146780822` executed `zz-mcp-health-probe.test.ts` **10/10**.
These observations do not prove live identity-provider interoperability, detector quality or certification; corresponding active rows remain.

### Baseline corrections that must not become new work

Circuit breakers, deadlines, payload limits, SQL rate counters, the declarative JSON workflow engine, task DAGs,
blocking heuristic guardrails, SAML/SCIM and partial compliance evidence packs already exist.
“All seven optimization techniques are wired” was an overclaim: batching is estimate-only (GEM-s2-4).
Transparent MCP expansion must remain explicitly governed; the old proposal for “ungoverned pass-through” is not an implementation instruction.
GEM-D9's network-location half is implemented; device posture remains a separate decision.
SOAR, live collectors, model-backed detectors and live-provider assurance are not closed by removing old prose.

## Update protocol

Keep stable IDs. Update an active row only with source/test evidence; record the fixing commit and limits when marking RESOLVED/DONE.
Move verified closures to the compact register and preserve detail through immutable Git links. Do not resurrect duplicate old sweep claims.
