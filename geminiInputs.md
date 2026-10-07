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
| GEM-open-3 | n/a | Governed MCP coverage | PARTIAL — old absence claim superseded 2026-10-07 | ADR-0185; `packages/shared/src/batch3.ts`, `apps/gateway/src/mcp-protocol.ts`: governed resources/prompts/completion/logging methods; Streamable HTTP/SSE/stdio transports; source checked on main fcec5e81 | Sampling, elicitation, roots and resource subscriptions deliberately refused; broad transparent proxying is not claimed | owner: future governed extensions only; do not rebuild shipped coverage |
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
| GEM-C7 | n/a | SOAR webhooks on severe violations | PARTIAL — generic webhook absence claim superseded 2026-10-07 | ADR-0162 alert chat notifications; ADR-0173 batch2b `apps/gateway/src/outbound-webhooks.ts` provides signed subscriptions/retries; registry `packages/shared/src/outbound-webhooks.ts` has prompt/trace/annotation/automation families | Severe governance-alert event family and repeat-violation auto-revoke/isolate remain unbuilt; existing generic webhooks do not close these gaps | owner: define severity/response contract before implementation |
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

## Reassigned research delivery — 2026-10-04 01:57 UTC

Owner reassigned G10–G15 to Codex. Corrected six-file delivery is published on
`dhruv/active` at `e9bf0f95c43eb66837da0a5d513e837c58452e07`.
[Historical defects and acceptance criteria](https://github.com/dhruvmahendrapatel/RegulAIt/blob/cf2df769b177c7e1f6c4ba3d081dd6ece5a696e3/geminiInputs.md)
remain in Git rather than being carried forward as current unsupported claims.
The narrow document defects below are addressed; this is NOT Claude's independent
VERIFIED decision, a completed legal crosswalk, an installed integration, or production approval.

| Task | Correction lifecycle | Delivery evidence | Remaining limitation / acceptance owner |
|---|---|---|---|
| G8 | RESOLVED/DONE, unchanged | Checklist correction at `86b9a59`; prior direct comparison retained in history. | No product-parity certification. |
| G10 | RESOLVED/DONE — unsupported-claim correction | R1: 35 proposed checks, primary links/dates, corrected 2025 risk IDs; no invented normative ISO/NIST subcontrols. | Exact crosswalks explicitly UNVERIFIED; suite-owner registration and normative review before use. |
| G11 | RESOLVED/DONE — unsupported-claim correction | R2: 17 provider/host rows; retired examples removed; per-model price/context where verified; training, retention and residency separated. | Unknown model selections, contractual terms, region and compatibility remain UNVERIFIED, not approved. |
| G12 | RESOLVED/DONE — provenance correction | R3: 46 apps, 28 vendor-documentation MCP entries; Notion corrected; upstream reference servers no longer mislabelled official. | Unverified availability/auth is not absence; no runtime interoperability tested. |
| G13 | RESOLVED/DONE — document contract | R4: 12 templates, 5 steps each, 2 described skills each, instructions under 150 words, 0 subagents, schedules and scoped approvals; all integrations resolve to R3. | Original proposed workflows, not shipped automations. |
| G14 | RESOLVED/DONE — unsupported-claim correction and reconciliation | R5: 22 rows, all 13 feed keys classified; exact UK SI shows duty to prepare code, not finished-code commencement; standards separated from laws. | Formal EU amended-text review and flagged unknowns remain; source-backed feed corrections require Claude-owned data work. |
| G15 | RESOLVED/DONE — document contract | R6: ten complete fenced Markdown blocks with YAML frontmatter, unique kebab-case names and all required sections; invented API flag removed. | Proposed starters; no installation or model execution claimed. |

### Verification and formal board gate

Baseline local/upstream: `2e89cdcea0cb98e18a2716b02b282c2077a6e99d`;
research commit: `e9bf0f95c43eb66837da0a5d513e837c58452e07`.
Read-only primary-source browsing and scoped file inspection; no cloud/model calls,
database tests, product source edits, or sibling-repository edits.

- Inline Node `assert` validator, executed with a PowerShell here-string piped to `node`: PASS. Checked table column counts/nonempty cells/source dates, 35/17/46/22 row counts, descriptions ≤90 chars, 12 template contracts, skill/catalog referential integrity, ten complete frontmatter blocks, and all 13 actual feed keys. Initial validator attempts failed on its CRLF handling and single-quote-only key regex; both validator assumptions were corrected before the passing rerun. These were not product test failures.
- `git diff --check`: PASS. `node scripts/coordination.mjs lint`: PASS.
- `pnpm install --offline --frozen-lockfile --ignore-scripts`: failed, cache lacked the locked Vitest package. `pnpm install --frozen-lockfile --ignore-scripts`: PASS; lockfile unchanged, lifecycle scripts disabled.
- `pnpm --filter @regulait/shared build`: PASS after dependency installation.
- `pnpm --filter @regulait/web exec tsc --noEmit` and `pnpm --filter @regulait/web build`: FAIL, exit 2 after dependencies. Existing `UseCaseOverviewPage.tsx:18-19` and `AgentsPage.tsx:26` imports resolve ambiguously between `AgentStewardship.tsx` and `agentStewardship.ts` on this Windows checkout (TS1261/TS1149 plus missing component exports). No product code changed by this task.
- `pnpm exec vitest run scripts/coordination.test.mjs`: FAIL before tests, `SyntaxError: Invalid or unexpected token`; zero tests executed. `node --check scripts/coordination.test.mjs`: PASS. Runner/transform cause remains UNVERIFIED; do not label this an assertion failure.
- Initial pre-install builds also failed for missing dependencies; those diagnostics are superseded by the post-install results above.

All six research corrections are delivered, but the board deliberately retains BLOCKED
for the formal Codex web-build/review gate. Claude may accept the research-only shared-build
gate or request a separately scoped Windows import fix; no gate is silently waived.
Claude alone marks the board VERIFIED. No remaining correction is assigned back to Gemini.

### Next actionable work

1. Claude: correct the regulatory feed using R5, especially withdrawn CFPB guidance,
   NYC effective vs enforcement dates, and voluntary-standard status; add filter/count tests.
2. Resolve/review the Windows web gate and coordination runner issue independently of research content.
3. Review UNVERIFIED catalog cells before promotion to code. AER-050 remains a separate
   intake-recovery priority and is not closed by this delivery.


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

## User-directed takeover review — 2026-10-07

The owner asked Codex to review Gemini and finish its pending work. The unmerged original `gemini/g16-g18` at `9ab8b550` is preserved; its unsupported DONE/READY claims are superseded by this review. Research PRs #157–159 and #162–165 are now merged after review, with primary evidence and explicit unknowns; #166 and #167 are being updated for minor review follow-ups. Claude retains independent review/VERIFIED/merge ownership.

| Task | Current delivery | Evidence / remaining gate |
|---|---|---|
| G16 | MERGED — [#157](https://github.com/dhruvmahendrapatel/RegulAIt/pull/157), `5593177e` | R7 has 175 rows, all 22 ADR projects, all 64 direct external dependency names, third-party manifests and 15 clean-room features; actual code/data/CI/planned modes and licence scopes. Manual contract validator, shared build, web tsc/build PASS. Unknown ownership deltas and missing artifact licence text are explicit. |
| G17 | BLOCKED primary verification — [#158](https://github.com/dhruvmahendrapatel/RegulAIt/pull/158), `700081f8` | R8 splits 29 actor/recipient/stage-specific leads. Exact legal bodies returned proxy 403/no body, so all rows are UNVERIFIED and ineligible for encoding; quotes/applicability/exceptions remain open. No invented deadline quotations. |
| G18 | MERGED — [#159](https://github.com/dhruvmahendrapatel/RegulAIt/pull/159), `6aabb3c3` | Five projects/seven checks each, actual release pages and pinned licence/telemetry source. Empty public advisories are bounded API results. Promptfoo opt-out still attempts a disabled-event HTTP path in source. Runtime air-gap and image digest/signature proof remain UNVERIFIED admission gates. |
| G10 | Corrected proposals delivered; normative gate BLOCKED — [#162](https://github.com/dhruvmahendrapatel/RegulAIt/pull/162), `60066756` | 35 candidate NIST references with individual rationales; OWASP SSRF/scope correction primary-checked; Art. 50(1)/(2) separated. NIST/EU bodies proxy 403, ISO licensed control text unavailable: no normative completion or code promotion. |
| G11 | Pricing follow-up BLOCKED — [#163](https://github.com/dhruvmahendrapatel/RegulAIt/pull/163), `1febafba` | Current flagship selection and long-context pricing tiers explicitly UNVERIFIED. Oct4 historical IDs/prices preserved; current vendor model/pricing pages return proxy 403. Stale review prices are not attached to newer selected IDs. |
| G12 | Primary-source corrections delivered — [#164](https://github.com/dhruvmahendrapatel/RegulAIt/pull/164), `1430c225` | Six rows refreshed from actual vendor GitHub README bodies: Salesforce hosted GA, Atlassian/Bitbucket, Intercom OAuth/bearer, PagerDuty hosted successor. Exact Salesforce first-GA date and PagerDuty hosted endpoint/scopes remain UNVERIFIED; no runtime/account test. |
| G13 | MERGED — [#165](https://github.com/dhruvmahendrapatel/RegulAIt/pull/165), `0337f032` | All 12 instructions have distinct template-specific Never and approval decisions; max 109 words, five steps/two skills/zero subagents each. Original proposals; no installation/execution claimed. |
| G14 | Structural/source review delivered; legal gate BLOCKED — [#166](https://github.com/dhruvmahendrapatel/RegulAIt/pull/166), `31c19917` | 24 calendar rows plus current 13-key reconciliation. New legacy/Utah/CA/Canada/Colorado legal leads remain UNVERIFIED. Current feed already fixes old CFPB/NYC/voluntary/Colorado narrative gaps; The former Art. 50 narrative/controlRefs mismatch is fixed by Claude on current main; its old snapshot remains historical. |
| G15 | Prior VERIFIED scope retained | Unchanged R6 locally rechecked: ten unique kebab-case names, frontmatter and required headings. No starter installation/model run. |

Historical Windows web gate and coordination-runner failure above are not current Linux failures: current shared build, web typecheck/build and 328 web units pass. No Windows execution is newly claimed. Current main coordination lint passes after Claude pruned its stale inbox; historical red results remain preserved.

### Current UX adjudication

The original Oct3 scan above is historical. Current source/browser review supersedes its open implementation claims:

| ID | Current state | Source / browser evidence and limits |
|---|---|---|
| UX-AG-1 | RESOLVED/DONE already on main | `c0a684a4` implements staged Add/reorder/remove, Cancel and explicit Save chain. Two existing mocked browser cases pass, including exact PUT body and failed-save draft preservation; no speculative rebuild. |
| UX-AG-2 | RESOLVED/DONE draft-refetch defect at `aed4d682` | Registration creates a new agent; the original existing-binding claim was inaccurate. Two genuine regressions reproduce a selected endpoint disabled/removed during the draft (baseline select becomes empty). Fix retains an unavailable selected option, explains it, preserves other fields and blocks submission until an enabled endpoint is chosen. Disabled endpoints are never newly bindable. Server race/refusal guard remains necessary. |
| UX-AG-3 | Design improvement delivered at `aed4d682` | Native explicit Unpriced/Record token prices choice; unpriced disables inputs and omits staged costs, while recorded0 remains valid. Browser exact-body test and light/dark axe pass. No inference that self-hosted means unpriced or free; existing model-pricing editor remains a separate explicit PATCH path. |
| UX-AG-4 | RESOLVED/DONE old scaffold absence claim superseded | Current `BuilderAgentEditorPage.tsx` and ADR0172 are implemented, with project billing added at `d140067b`. Existing list/creation/import/editor/conversation/sharing/channel/configuration mocks 20/20 pass. This does not certify every future builder roadmap feature or live vendor integration. |
| UX-AG-5 | RESOLVED/DONE already on main | `c0a684a4` role-grant explanation links to Roles and Users. Existing browser case confirms the Roles link works; no role/backend semantics altered. |

Validation at the UX branch: `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-mock.config.ts agents-registration.mock.spec.ts agents-fallback-chain.mock.spec.ts models-portal.mock.spec.ts` **11/11 PASS**. Prior combined builder run had 20/20 builder plus 3/3 registration PASS and 3 fallback failures: outdated fixture path plus a missing-array guard in the new lookup; both corrected before final 11/11. Initial harness attempts used the wrong radio label/API path and are not red proofs. Corrected baseline `ux-red.log` records 3 genuine failures: endpoint select value empty in disabled/removed cases; explicit pricing choice absent. Raw screenshots/traces/logs under `/workspace/.regulait-onboarding/gemini-review/ux-final-results/` and `ux-red-results/`; screenshots include endpoint-disabled.png, endpoint-removed.png and explicit-unpriced.png.

`pnpm --filter @regulait/web test` **328/328 PASS**; web `tsc --noEmit`, web build and `git diff --check` PASS. Fresh isolated `demo:prepare` **19/19 PASS**, 19s, synthetic fixture signing key. First preparation failed only the missing-signing-key prerequisite (18/19); a new empty database with the prerequisite configured passed. No gateway/shared code, new dependency, live model or vendor account touched. Native React state/select/input controls implement product UI; no new library is needed.

### Remaining scope boundaries

The old Active gaps table is a product roadmap/owner-decision ledger, not Gemini's Markdown task assignment. Its still-open concurrency, YAML, detector/collector/DLP/response/SCIM/live-tenant/certification work is not declared complete by this takeover. Current source confirms estimate-only batching and serial dispatch (`orchestration.ts`) and the unprepared model-redaction guard (`projects.ts:555`) remain. Governed MCP coverage and generic outbound webhooks have now been reconciled above. New gateway architecture, live tenant credentials, certification and external destinations require their actual contracts/evidence; none is fabricated from the old scan. No action is assigned back to Gemini for the delivered corrections; remaining verification gates are explicit for Claude/owner review.

### Review follow-up — 2026-10-07

R167-01 requires both input and output rates when Record token prices is selected, including an explicit zero; programmatic submission also refuses missing rates. R167-02 tracks an explicit choice separately from initial inference, so Unpriced survives switching providers while keeping staged prices disabled and omitted. R167-03 updates the real custom-provider journey to current Unpriced copy. R167-05 corrects takeover spacing and current merge status. Claude’s R167-04 backend disabled-endpoint registration guard is now on main and retained; the earlier UI guard alone did not enforce that API boundary.

Three new pricing regressions genuinely fail against the pre-fix source (two missing-rate cases and provider-switch intent). Final registration/fallback/model suite **14/14 PASS**, web units **336/336 PASS**, production build/typecheck PASS. Local evidence, not committed: `/workspace/.regulait-onboarding/gemini-review/ux-pricing-{red.log,red-results,green.log,green-results,units.log,build.log}`. The calendar disclaimer and Utah consolidation are updated in #166; research follow-ups are separate.

Fresh real custom-provider journey **10/10 PASS**, including the updated Unpriced copy and disabled-endpoint behaviour. The isolated fixture now explicitly enables/restores the org feature and borrows/restores only demo-labelled seeded egress rows; otherwise fresh secure-default seeding made the old empty-allow-list/capability-on assumptions fail before the pricing assertion. Restoration was independently checked: org capability false and one demo-labelled host restored. Earlier two fixture-precondition failures are excluded from passing product evidence. Local evidence, not committed: `gemini-review/ux-phase5-review-isolated{.log,-results}`.
