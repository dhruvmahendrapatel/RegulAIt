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
| G8 | n/a | Credo parity checklist refresh | RESOLVED/DONE | `86b9a59`; Codex source review 2026-10-04 | Four requested document corrections present; product parity remains unclaimed | Closed; see delivery review below |

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

## Gemini delivery review — 2026-10-04 UTC (owner-requested)

Reviewed delivery `50f004c` on target `dhruv/active`, at local/upstream snapshot
`63bd838c5e2109a450e7e28464df51dfaa52b53e` after incorporating concurrent
Gemini delivery `86b9a59`. Publication uses a clean detached worktree based on that
upstream commit and targets only `dhruv/active`; prior local drafts remain preserved.
All six research files were inspected structurally; primary-source spot checks below
disprove readiness. This is not exhaustive verification of every provider or legal fact,
nor a finding that these research-only defects are executing in the product.

| Task | Review status / priority | Direct evidence and impact | Required correction / acceptance |
|---|---|---|---|
| G8 | RESOLVED/DONE (document corrections only) | `86b9a59` changes checklist lines 24,44–53: requested Partial statuses, preview caveat and named vendor-portal roadmap item are present; ROADMAP.md:824 contains that portal item. | Four original correction requests are addressed by direct document comparison. No new claim of full parity, test rerun or live vendor validation. Historical concern preserved in Git. |
| G10 | CHANGES-REQUESTED / OPEN, high | `R1-evaluator-control-catalog.md:3,29` misnumber disclosure and excessive-agency checks under the claimed OWASP 2025 namespace. Sources are names, not URLs; ISO subcontrol/title pairs are unsupported by the suite identifier register. Incorrect mappings could become false compliance evidence. | Verify every mapping against the correct framework edition and exact source, recording checked date. Correct 2025 IDs, distinguish proposed relevance from compliance proof, and mark inaccessible/unverified mappings UNVERIFIED. Pass: every populated identifier resolves to its claimed title/version and every mapping has rationale plus primary citation. Do not invent ISO subcontrols from memory. |
| G11 | CHANGES-REQUESTED / OPEN, high | `R2-model-provider-facts.md:4` lists retired Sonnet 3.5 June-2024 as GA. Rows give one context/price pair for two models and mix no-training with zero retention. A pricing homepage does not substantiate retention/residency. | Recheck each exact API ID and lifecycle on its actual host; pair price/context with each model and pricing tier. Separate training, retention, eligibility, regional availability and endpoint compatibility with primary links and checked dates, or UNVERIFIED. Pass: no retired model represented as current and each commercial/security claim is individually attributable. |
| G12 | CHANGES-REQUESTED / OPEN, medium | `R3-integration-catalog.md:18` says no official Notion MCP found, contradicted by Notion's own hosted-server documentation. Rows such as line 32 place an upstream reference-server URL in the official-vendor column without verifying vendor ownership. | Recheck MCP availability and maintenance; distinguish vendor official, reference, community and unverified. Cite direct server/auth documentation and checked date; qualify unsuccessful searches. Pass: Notion corrected, each claimed official server has vendor provenance, and proposed reach is not represented as shipped RegulAIt integration support. |
| G13 | CHANGES-REQUESTED / OPEN, medium | `R4-agent-template-ideas.md:45,60` provide no skills; other templates often have one, rather than required 2–3 with descriptions. Line 185 names Google Slides absent from G12. Twelve concepts exist but deliverable contract is incomplete. | Supply 2–3 named, described skills per template and ensure integrations resolve to G12 (or label a proposed catalog addition). Document approval/authorized scope before external writes. Pass: all 12 templates satisfy steps, word limit, skills, subagents, schedule, catalog integration and approval requirements; label recipes proposed rather than implemented. |
| G14 | CHANGES-REQUESTED / OPEN, high | `R5-ai-regulation-calendar.md:12` asserts a UK instrument/date with only gov.uk homepage; this review could not substantiate that exact claim. Line 18 classifies a voluntary standard as a law-like in-force milestone. No explicit G4 feed comparison is delivered. | Cite exact official instrument and commencement/amendment provision per row, with checked date distinct from milestone. Mark unsubstantiated claims UNVERIFIED rather than guessing. Separate standard publication/certification from statutory obligation. Pass: every required jurisdiction covered and every relevant existing feed item classified match, contradiction or unverified with evidence. No legal-validity certification is implied. |
| G15 | CHANGES-REQUESTED / OPEN, medium | `R6-skill-starters.md:1–17` and subsequent entries fence only YAML metadata, leaving the body outside and lacking actual frontmatter delimiters. Line 141 suggests an unspecified `opt_out=true` API flag. Ten outlines exist, not ten conformant starter blocks. | Fence each complete starter with YAML frontmatter and all required headings; validate each can be extracted unchanged. Cite factual/legal/API claims with checked dates or label illustrative/UNVERIFIED. Never convert a generic example flag or automated risk classification into an authoritative setting/legal determination. Pass: ten complete parseable blocks, unique kebab-case names, descriptions, required sections and explicit unknown/human-review handling. |

Paths in the table are under `docs/research/` except G8's existing checklist.
Task IDs are reused rather than opening duplicate product findings. G8 is closed in its narrow document-correction scope.

### Primary-source checks (accessed 2026-10-04 UTC)

- [OWASP's 2025 list](https://genai.owasp.org/llm-top-10/) places sensitive-information disclosure at LLM02 and excessive agency at LLM06, contradicting the R1 examples. Other mappings still require row-by-row validation.
- [Anthropic retirement history](https://platform.claude.com/docs/en/about-claude/model-deprecations) records Sonnet 3.5 retirement on 2025-10-28. A historical model should not occupy a current GA flagship field.
- [Notion MCP documentation](https://developers.notion.com/guides/mcp/overview) documents a Notion-hosted remote server and OAuth authorization. This directly refutes the R3 negative, not every other row.
- [European Commission implementation announcement](https://digital-strategy.ec.europa.eu/en/news/ai-omnibus-enters-force) supports the calendar's later high-risk phase dates. Do not blanket-revert those dates merely because older suite guidance differs. Formal amended-text retrieval was incomplete in this pass; G14 still needs provision-level evidence and feed reconciliation.
- Suite `docs/contracts/control-identifiers.md` is the repository-required identifier gate; it does not substantiate R1's asserted ISO subcontrol/title pairs. This is an unsupported-mapping observation, not a licensed-text verification of every ISO control.

### Review execution and next handoff

Source inspection used `Get-Content` on the board, six research files, G8 checklist,
feedback and suite identifier contract; `rg -n` located the cited claims.
No cloud calls, provider invocations, database tests or product mutations were used.
The board's prior X11 backend blocker was stale: gateway `chatops.ts:247` returns
`notifyAlertMinSeverity`; X11's existing verified closure remains intact.
Codex's assigned review is complete; Gemini should repair G10/G11/G14 first, then
G12, then G13/G15, before Claude's acceptance review. The separate AER-050
remaining recovery/navigation work is not closed by this board cleanup.


### Concurrent UX scan validation and execution limits

Gemini's UX-AG-1..5 text above is preserved. Source checks at the reviewed snapshot:
UX-AG-1 immediate saves are confirmed (`AgentsPage.tsx:482–497`); UX-AG-5's
role navigation opportunity is supported at line 797. UX-AG-3 is a design suggestion,
not a reproduced defect; unpriced and self-hosted must not be equated with zero cost.
UX-AG-4's editor scaffold is confirmed, but “entire experience missing” is too broad:
this is planned ADR-0172 work, not evidence that existing admin registration is absent.
UX-AG-2 remains UNVERIFIED as stated: `RegisterAgentCard` initializes `EMPTY_AGENT`
at lines 171–193 and POSTs a new agent, not an existing-binding editor. A provider
being disabled during an in-progress draft is a separate case needing reproduction;
do not allow binding disabled endpoints as a speculative fix.

`node scripts/coordination.mjs lint` and `git diff --check` passed on the initial draft.
`node --test scripts/coordination.test.mjs` failed before executing assertions:
missing `vitest`; the file requires the Vitest runner, not Node's test runner.
No dependency installation or product test pass is claimed. Final publication checks
are recorded in the commit handoff; docs-only review did not exercise runtime UX.

## Update protocol

Keep stable IDs. Update an active row only with source/test evidence; record the fixing commit and limits when marking RESOLVED/DONE.
Move verified closures to the compact register and preserve detail through immutable Git links. Do not resurrect duplicate old sweep claims.
