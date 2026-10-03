# Codex review findings and implementation handoff

This file has two parts. **Part 1** is the status ledger: one row per finding (AER-001..043, the
2026-09-06 F01..F08 recommendations), its current status with evidence, and who acts next. It is the
authoritative current state; Codex evaluates and confirms closures here. **Part 2** is Codex's
append region: the latest automated run and the implementer updates it answers. Earlier runs
(2026-09-06 .. 2026-09-30) and the original F01..F08 recommendation document are preserved verbatim
in `docs/reviews/codex-runs-archive-2026-09.md`.

## Status ledger — current state of every finding

Date: 2026-10-02. Branch `dhruv/active`, HEAD `0617ace`.
Basis: the adversarially verified audit of every item at HEAD `21b3094` (auditor + verifier; verifier wins on disagreement), plus today's post-audit fixes, each confirmed in `git log`: `65581bd`, `749ee75`, `297d0b9`, `b5418e8`, `8ea024e`, `062d90e`, `154d171`, `b186915`, `1b9d6cb`.
Status: CLOSED = acceptance met per audit or by a listed fix; PARTIAL = materially improved, a named criterion unmet; OPEN = otherwise; WITHDRAWN = not applicable.
Next: `claude` (code/doc work) · `codex-confirm` (closure to be acknowledged by Codex) · `owner` (decision needed).

| ID | Severity (original) | Title | Status | Evidence | Remaining gap | Next |
|---|---|---|---|---|---|---|
| AER-001 | HIGH | MCP budget gate without ADR/adversarial tests | CLOSED | ADR-0103; `mcp-project-budget.test.ts` (77692dc: direct, proxy-route and delegated-worker refusal, zero upstream/billing, unpriced block, warn_only, null-project); `compliance-cost.test.ts:107` (profile block overrides org warn_only); runs in the green gateway CI suite | — | codex-confirm |
| AER-002 | MEDIUM | 'Paid tool calls' wording vs freeze predicate | CLOSED | 414c006 (ADR-0103 amendment: "project dispatch FREEZE", 0103:194); `mcp-project-budget.test.ts:232`; 1b9d6cb rewords the `mcp-proxy.ts:251` comment | — | codex-confirm |
| AER-003 | MEDIUM | Clean-checkout verification not reproducible | PARTIAL | README.md:85-140 pinned sequence (corepack pnpm@10.33.0, `--frozen-lockfile`, build, `tsc --noEmit`, disposable-DB tests, preflight); ci.yml:105-112 frozen-lockfile | No single command that also asserts a clean `git status --short` and shows a deliberately failing control; no approved build-script policy (`onlyBuiltDependencies`) | claude |
| AER-004 | HIGH | Approval consent not policy-bound, no expiry | CLOSED | 7b44da6 (Codex DONE 09-30); migration `0119_approval_policy_epoch`; `governed-evaluate.ts:230`, `mcp-proxy.ts:263-274`; `consent-context-expiry.test.ts` (15); 1b9d6cb fixes the `schema.ts:1307` comment (NULL digest is not spendable; epoch lock described) | — | codex-confirm |
| AER-005 | MEDIUM | ADR-0115 evidence; PENDING said S22 unassessed | CLOSED | ADR-0115; `adr0115-eval-result-scrub.test.ts` in CI; PENDING.md:162 closes S22; 1b9d6cb rewrites PENDING.md:155-156 (S22 assessed and closed, at-rest caveat kept) | — | codex-confirm |
| AER-006 | MEDIUM | International PII grammar, missing admin UI | PARTIAL | `pii-international.ts:568` `DEFAULT_INTERNATIONAL_CATEGORIES = []` (default-off held); conformance suite wired | Every-digit separators still accepted (`:346-347`, `countAadhaar :373`); stale 'DEFAULT-ON' comment `:455-459`; no web control, yet TESTING_CHECKLIST.md:125 (row 71) sends operators to Org settings | claude (UI-vs-API-only: owner) |
| AER-007 | HIGH | Non-admin signed bundles leaked org audit | CLOSED | b9df6d0 (Codex DONE 09-30); `reporting.ts:959` auditPayloadScope 'subject'; `export-bundle.test.ts:429-457` unrelated-sentinel isolation | — | codex-confirm |
| AER-008 | MEDIUM | Missing signing key left false success rows | CLOSED | 65581bd: key preflight before any success row (`app.ts:3990`, `reporting.ts:910`), accurate deny row on refusal, correcting row after a failed build; `export-bundle.test.ts` "AER-008" exact row deltas for both routes (all 3 cases fail pre-fix); `demo-export-key.ts` + `demo:export-key`; `demo-check-lib.ts` "3 Evidence" beat; `demo-intake.spec.ts:173-176` clicks and asserts the gzip bundle; ADR-0116 amendment (2026-10-02); DEMO_SCRIPT §0 | — | codex-confirm |
| AER-009 | MEDIUM | Offline verifier ignored unlisted audit rows | PARTIAL | `verify-export-bundle.sh:333-361,452-458` derives the payload set from chain.tsv; `export-bundle.test.ts:643-652` 'unlisted audit payloads' | Two negatives missing: nonnumeric/alternate-spelling payload filename; isolated listed-payload-removed asserting 'AUDIT ROW MISSING' (test `:567-580` removes row+payload and hits 'sequence gap') | claude |
| AER-010 | HIGH | Cache hits bypassed shared dispatch gates | PARTIAL | b33de7c routes native and compat hits through the governed-dispatch core; `adr0119-compat-semantic-cache.test.ts:267-423` prime-then-tighten matrix | Item 4: no retained negative control (mutation seam or structural assertion) proving the matrix goes red when lookup moves above the gates | claude |
| AER-011 | HIGH | Compat cache key not request identity | PARTIAL | aa1e1b9 canonical SHA-512 commitment + collision guard (`semantic-cache-shared.ts`); `compat-core.ts:945-954` commits responseFormat/thinking/maxTokens/projectId/system/versions; adr0119 tests `:237-265`, `:424` | No paired-miss DB tests for response_format, thinking, project, prompt/config-version; no per-field omission negatives for the compat key; TESTING_CHECKLIST.md:127 (row 73) still says casing/spacing hit | claude |
| AER-012 | MEDIUM | Posture endpoint never calls Object Lock observe() | CLOSED | `6e3daec` (2026-10-03, `wt-sec2`): `buildPostureReport` is async on the LONG-LIVED sink — `registerPosturePresetRoutes(app, db, { sink })` receives `buildApp`'s `auditAnchorSink` (resolved once at registration otherwise, never per request) and awaits `observe()`, reporting `current.lockMode` + `disclosure` beside the grade; the harden response's posture goes through the same path. `aer012-posture-anchor-observe.test.ts` 10/10: COMPLIANCE (true) / GOVERNANCE / no-Object-Lock / errored probe / anchoring-off apps over the audit-chain tests' fake S3 transport, GET + harden assertions, probe counts proving the cached observation is reused and a failed probe is never cached, null-sink negative control. File-level negative control: 9/10 fail with `posture-preset.ts` + `app.ts` at the previous text. `adr0118-hardened-posture.test.ts` 14/14 (unit-level calls now await), `posture.test.ts` 11/11, `audit-chain.test.ts` 57/57 (+9 MinIO-skipped) | — | codex |
| AER-013 | MEDIUM | Hardened preset mutation/audit not atomic | CLOSED | `40990d6` (2026-10-03, `wt-sec2`): harden follows ADR-0132 — `loadOrgSettings` initializes the singleton, then `db.transaction` locks it `FOR UPDATE`, idempotency is decided against the locked committed row, the update `RETURNING` the row the report is built from and both audit rows (`org-posture-hardened`, `mrm-enforcement-enabled`) commit together or not at all; groups validated before the tx (non-array → 400 `invalid_posture_groups`, unknown refuses the whole request, duplicates de-duplicated). `aer013-harden-atomicity.test.ts` 7/7: 12 concurrent applications → 1 applied + exactly 1 audit row per fact; BEFORE INSERT trigger rejecting the preset's row → 5xx, settings/ledger/updatedAt unchanged, same request applies once the injection is removed; retry no-op incl. updatedAt; empty/duplicate/unknown/non-array groups. File-level negative control: 3/7 fail at the previous text (rollback, duplicate de-dup, non-array) | Disclosed: the 12-way concurrency case passed on the old code too (`app.inject` did not race the old read/update window), so it pins the invariant rather than discriminating the old code; the rollback case is the discriminating one | codex |
| AER-014 | HIGH | Rate-limit simulation uses present-time counter | OPEN | `policy-simulation.ts:358` no replay time; `governed-evaluate.ts:437` window from `Date.now()`; ADR-0120:123 'exactly' claim unqualified | All unmet: replay clock, strictly-before counting, 'indeterminate' on truncated lookback, two-per-hour ordered test, `Date.now()` negative control | owner (replay-clock fix vs downgrade ADR-0120 claim) |
| AER-015 | MEDIUM | Outlook adapter not creatable via product | PARTIAL | create schema accepts outlook; `adr0121-outlook-chatops.test.ts` (public-route create; schema/adapter parity `:247-258`); `OUTLOOK_DEFAULT_GRAPH_BASE_URL` (connector-provider index.ts:835) | `connectorDefaultBaseUrl` (index.ts:1882-1910) has no 'outlook' case, so strict egress refuses without baseUrl; `ConnectorsPage.tsx:26` omits outlook/teams; no UI/egress parity; no strict-egress e2e | claude |
| AER-016 | MEDIUM | Non-admin preview admits 20k-row N+1 | OPEN | `route-classes.ts:258` non-admin; `shared/policy-simulation.ts:409-412` caps 20k/5k; serial `governedEvaluate` loop `:358` | All unmet: bounded query growth, per-caller/global concurrency, timeout/cancel with honest incomplete state, load instrumentation | owner (quick mitigation vs job redesign) |
| AER-017 | HIGH | require_approval could authorize nothing | CLOSED | dee2e0e (Codex DONE 09-28); `policy-kernel/src/index.ts`; `adr0124-kill-switch.test.ts:494-630` 'AER-017' suite | — | codex-confirm |
| AER-018 | HIGH | Kill switch excluded deploy/Git/infra/PM | PARTIAL | 8507fa3 `external-effects.ts:4-45` runExternalWrite re-reads the mode before 10 ops; wraps workflows.ts, infra.ts, pm.ts; `external-effects.test.ts` (2 cases) | No per-adapter barrier matrix (pause before the real call, flip mode, resume, counting fake stays 0); structural test covers named workflows/infra methods only, not pm.ts or new providers | claude |
| AER-019 | HIGH | Emergency-state and audit writes racy | CLOSED | 1bac371 (Codex DONE 09-30); `execution-control.ts` transactions; `zz-aer019-emergency-atomicity.test.ts` (fault injection, 20-way races, restart reread) | — | codex-confirm |
| AER-020 | MEDIUM | MCP discovery 'redacted' samples leak credentials | CLOSED | `e09e4cb` (2026-10-03, `wt-sec2`): `scrubEvidenceSample` in `packages/shared/src/mcp-discovery.ts` composes the ADR-0099 credential scrubber (`scrubAuditText`, shared rules: AWS/PEM/JWT/assignment/vendor/`rgl*`) + `redactPII` (email/SSN/Luhn card/phone) + the space-separated `Authorization: Bearer|Basic <value>` header shape, applied to the FULL line before the 200-char slice; both scrubbers already live in `@regulait/shared` (no gateway import); `shadow-ai.ts` returns the scrubbed samples unchanged. `packages/shared/src/mcp-discovery.test.ts` 33/33 (11-entry corpus — AWS key, sk-, ghp_, xoxb-, JWT, opaque bearer, Basic, rgl_, api_key=, email, Luhn card — each early on the line AND starting at offset 188 so it straddles the cut, no 8-char window survives; marker shape; identity on a clean line). `adr0122-mcp-discovery.test.ts` 8/8 (preview/apply serialized bodies, the apply audit row and GET /v1/shadow-ai/findings carry no corpus value; verbatim-sample control). File-level negative control: 24/33 shared + 2/8 gateway fail at the previous text. `audit-scrub.test.ts` 20/20, `pii.test.ts` 17/17, `shadow-ai.test.ts` 19/19 | — | codex |
| AER-021 | HIGH | Model deadline omitted Google/Gemini | CLOSED | 4aea3dd (Codex DONE 09-28); AbortSignal.timeout at the provider resolver (`packages/model-provider/src/index.ts`); 132/132 provider tests incl. Google header/body hangs | — | codex-confirm |
| AER-022 | HIGH | MCP breaker guarded only outer handshake | CLOSED | c37c9b9, dd50ab2 (ADR-0129), 1d231e0 (Codex DONE 09-30); `zz-aer022-operation-breaker.test.ts` (6); g2-upstream-deadlines regressions restored | — | codex-confirm |
| AER-023 | MEDIUM | Breaker state/audit transitions non-atomic | CLOSED | 324b231 (ADR-0133; Codex DONE 09-30); `zz-aer023-breaker-atomicity.test.ts` 4/4 (audit fault injection, 20-way races) | — | codex-confirm |
| AER-024 | MEDIUM | Open breaker hides admission/egress refusals | CLOSED | `5a7244c` (2026-10-03, `wt-sec2`): `preflightUpstream` (`assertAdmitted` then `checkMcpServerUrl`, audited exactly as the connect-time guard audits, same error classes, no DNS lookup for a held server, breaker neither read nor elected) runs before breaker election in `executeGovernedToolCall`, before `breakerAdmits` on the route's manifest path, and before the worker-discovery election; the hijacked tools/call maps both refusals to the manifest handler's `Denied by policy` MCP error instead of a generic internal error. `zz-aer024-breaker-preflight.test.ts` 5/5: held and egress-refused servers behind an OPEN breaker — manifest 403 `mcp_admission_held` / `egress_blocked` + own audit row (`mcp-admission-held`, `mcp-server-egress-blocked` phase connect), proxy tools/call + direct primitive named refusal, zero upstream requests, breaker row untouched; admitted server still gets 503 `mcp_upstream_circuit_open`. File-level negative control: 4/5 fail at the previous text, positive control passes. Lift policy unchanged: `g2-upstream-deadlines.test.ts` 13/13, `zz-aer022` 6/6, `zz-aer023` 4/4, `mcp-proxy.test.ts` 152/152, `mcp-admission-auth` 25/25, `mcp-admission-rescan` 16/16, `mcp-oidc-egress` 20/20 | Literal-criterion note: a post-hijack tools/call cannot answer an HTTP 403; it answers the same named policy refusal the manifest handler uses, with the audit row | codex |
| AER-025 | HIGH | Envoy adapter could treat deny as allow | WITHDRAWN | 46590d6 removed the adapter; `integrations/envoy/ext_authz.yaml` is a withdrawal notice; support claims reconciled under AER-031 | — | codex-confirm (close as withdrawn) |
| AER-026 | HIGH | Sample adapters trusted caller subject header | PARTIAL | 46590d6: `handler.lua:149-162` subject from consumer.custom_id, forgeable headers stripped `:51-61,:142`; `verify.mjs:474-480` three x-regulait-subject spellings | Untested: unmapped/ambiguous/disabled/deleted identities (consumer_not_mapped branch unreached), duplicate headers, subject header with no credential; audit lacks Kong consumer identity beside the resolved subject | claude |
| AER-027 | HIGH | PDP secret was unrestricted admin credential | CLOSED | 46f2919 + migration 0117: closed `dispatch\|pdp` key purpose; a PDP key reaches only POST /v1/authz/check; 9 focused tests in CI; Kong harness mints a purpose 'pdp' key | — | codex-confirm (formal DONE) |
| AER-028 | HIGH | Callout omits args, project, principal | PARTIAL | endpoint accepts args/projectId/principal (46f2919; `app.ts:2147-2195`; `aer028-callout-context.test.ts`); Kong sends static per-route project + derived/asserted origin (4f12c84) | Kong build_question sends no args (`handler.lua:83-89,:119-132`) so data-scope rules always deny; OIDC/SAML origins asserted; callout never binds/consumes approvals; no parity matrix | owner (forward scrubbed args vs narrow Kong to context-free authz) |
| AER-029 | MEDIUM | Guided intake controls lacked accessible labels | PARTIAL | e3b08ec real labels/ids (uc-compliance-tags, uc-intended-agent, uc-project); Playwright exact getByLabel; `IntakeWizardPage.tsx` wraps controls in Field | No @axe-core scan across every stage and both themes (none in apps/web); screen-reader name / Tab / Escape checks not shown; IntakeWizardPage not re-reviewed | claude (axe scan), else Codex accepts as-is |
| AER-030 | HIGH | Kong adapter not runnable; one action per route | PARTIAL | custom plugin with per-instance server_id/tool_name runs in the CI Kong job (integrations.yml) | All harness routes bind the same server/tool (`verify.mjs:290-347`): no two-route distinct-action test; forged server/tool/decision headers untested; disabled/unmapped consumers untested; only kong:3.6 + key-auth; `handler.lua:42` VERSION '0.1.0-unverified' | claude |
| AER-031 | MEDIUM | Envoy withdrawal not reconciled in claims | CLOSED | b8e9720 (Codex DONE 09-27); docs/deployment/README.md:17 | — | codex-confirm |
| AER-032 | MEDIUM | Disabled destructive controls hid reason from AT | CLOSED | `adminKit.tsx:213-245` RemoveButton aria-disabled + focusable reason; blocked-reason-a11y spec `:55-85` (Tab, Enter, Escape, focus return). Minor: spec covers 1 of 8 disabledReason sites via the shared component | — | codex-confirm |
| AER-033 | HIGH | Kong harness left admin key world-readable | PARTIAL | HIGH exposure fixed: pdp-purpose key, vault reference, 0700 mkdtemp (`verify.mjs:183,225-227`), finally revoke/rmSync/DROP `:608-627` | Fixed DB `regulait_kong_e2e`, container, ports 3210/8099/8000 plus `DROP … WITH (FORCE)` and `docker rm -f` at start: concurrent runs destroy each other; no SIGINT/SIGTERM cleanup; no non-runner canary read | claude |
| AER-034 | MEDIUM | Kong verification claim exceeds its gate | PARTIAL | b8e9720 approval_required / non-200 / unparseable cases (`verify.mjs:481-512`); integrations.yml paths include apps/gateway/src/** and packages/** | kong:3.6 and postgres:16 are mutable tags labelled 'PINNED' (`:46,:60,:63`), no digest logged; no two-route test; reserved-field forgery, missing mapping, disabled identity untested; pnpm-lock.yaml not in trigger paths | claude |
| AER-035 | HIGH | Copilot apply not concurrency-safe/atomic | PARTIAL | 946ba2c, f203e7c, f587c5f: one FOR UPDATE transaction, 20-way races (4 kinds), trigger-injected fault at the last audit write; `zz-aer035-apply-atomicity.test.ts` | Item 4: no process-kill/reconnect recovery test (file `:381-391` says argued, not tested); a `pg_terminate_backend` mid-transaction + single re-apply would prove it | claude (or owner accepts the residual) |
| AER-036 | HIGH | Kong could label API-key traffic as SSO | PARTIAL | 4f12c84 `derive_session_origin` (`handler.lua:112-117`) api_key/password from the credential, contradicting assertion refused; harness asserts the exact origin (`verify.mjs:540-566`) | OIDC/SAML origins remain operator assertions (`:177-183`); no per-request derivation; no mixed-auth / ambiguous-metadata tests | owner (build OIDC/SAML derivation vs narrow the claim) |
| AER-037 | MEDIUM | Capped health sweep starved the tail | PARTIAL | 7b3e9b0 lastHealthProbeAt rotation, broken-first queue, backlog reporting (`mcp-health-probe.ts:193-250`) | Batch SELECT `:229-235` and claim UPDATE `:249` are separate, no FOR UPDATE SKIP LOCKED; disjointness comment `:244` unsupported; no two-sweep test | claude |
| AER-038 | HIGH | Retry from readOnlyHint could duplicate execution | CLOSED | `attemptsForToolKind` always 1 (Codex DONE 09-30); `zz-adr0128-upstream-retry.test.ts` durable-effect regression | — | codex-confirm |
| AER-039 | HIGH | MCP approvals not bound to server target | CLOSED | 749ee75 (ADR-0166): `approval-binding.ts` v3 digest {serverId, url, allowPrivateRanges, admissionManifestDigest}; `governed-evaluate.ts`; `mcp-proxy.ts:663-667,:703`; 297d0b9: GET /v1/approvals `boundTarget` from the queue-time audit row (`app.ts:2726,2939`), McpActionReview Target line, `approvalReview.test.ts`, `mcp-action-review.spec.ts`; `zz-aer039-mcp-target-binding.test.ts` 11 cases (URL and posture via API and SQL, drift via real tools/list resync, mid-connect barrier, breaker churn and lastHealthProbeAt-only keep consent, fresh review names B); negative controls recorded. Disclosed residual: FNV-1a manifest digest is a change detector, not cryptographic | — | codex-confirm |
| AER-040 | MEDIUM | Approver-review tests outside CI gates | CLOSED | apps/web `test` = `vitest run --dir src` (8ea024e; approvalReview.test.ts runs in `pnpm -r test`); b5418e8 + 65581bd: demo.yml `approval-review` job runs mcp-action-review + approvals-filter specs (all 5 ADR-0144 journeys, demo.yml:205) and the workflow triggers on app/mcp-proxy/governed-evaluate/export-bundle/reporting, packages/shared/**, packages/db/** (demo.yml:26-32); green at 1b9d6cb. Residual (disclosed): red CI for a broken assertion/journey shown locally only (needs a throwaway branch); required-check status is the owner's call | — | codex-confirm (+ owner: required check) |
| AER-041 | HIGH | Native cache identity collapsed requests | CLOSED | 3a91a93 (ADR-0146; Codex DONE 10-02); `zz-aer041-native-cache-identity.test.ts` 6/6 (CI 36967387569) | — | codex-confirm |
| AER-042 | HIGH | Intake UI sent invalid dataSensitivity | CLOSED | 8ea024e: `dataSensitivity.ts` deriveDataSensitivity (strictest wins; empty/unknown fail closed to 'regulated'), `dataSensitivity.test.ts` (4), `IntakeWizardPage.tsx:199`; `demo-governance.mock.spec.ts` 400 on non-enum; `demo-intake.spec.ts:88-91` real-DB persisted 'regulated'; 062d90e `use-case-data-sensitivity.test.ts`: public/confidential/regulated persisted (row, intake instance, audit detail), 'internal' is API-only (no category maps to it), 'restricted' gets 400 with zero use-case/workflow/audit rows | — | codex-confirm |
| AER-043 | MEDIUM | Concurrent monitor runs over-report transitions | CLOSED | 154d171 `governance-monitor.ts`: raised = raisedIds from onConflictDoNothing().returning, refreshed/resolved from rows actually updated; audit detail (`:288`) and response (`:308`) share the counts; b186915 inert `afterPlan` seam (`:91,:220`) holds pass A after its plan while B commits; `zz-aer043-monitor-concurrency.test.ts` (5) asserts raise 1/0 and resolve 1/0 with one audit row each, fails on the reverted code | — | codex-confirm |
| F01 | prio: first | Stabilize tests, dependable quality gate | PARTIAL | ADR-0106 `mock-socket-contract.ts` setupFile (vitest.config.ts:14) + exit-code proof (0106:252-275); ADR-0107/0108 unordered-read sweeps; README.md:84-147 pinned sequence; ci.yml `pnpm -r test` on Postgres; exact-head CI 37036782298 green at 21b3094 | S8 compat-longtail 409→500 undiagnosed (PENDING.md:270-315); order-dependence still surfacing (0fba74c, 1515f23 on 10-02), no N repeated clean runs recorded; stale 'Actions exhausted' claims (PENDING.md:225-227, CONTRIBUTING_PARALLEL_SESSIONS.md:137); phase1/phase2 Playwright in no gate | claude |
| F02 | prio: first batch | Budget enforcement across model/MCP/connector | CLOSED | `4229704` (2026-10-03, `wt-sec2`): the same `preDispatchProjectGate` now sits on POST /v1/connectors/:connectorId/invoke immediately after the entitlement decision resolves to allow and before credential/PII/guardrail/egress/provider work — 409 `project_budget_exceeded` (entitlement `decision` still reported), one `project-budget-cap` deny row (`objectType: connector`, `detail.phase: project-budget`), nothing executed, nothing billed; unattributed invokes unchanged. `connector-project-budget.test.ts` 6/6 (counting fake receiver: exhausted → 409, 0 upstream requests, 0 `usage_events`, audit row; healthy, unattributed and sanctioned-overage run and bill; warn_only runs, bills, escalates; profile `budgetEnforcement: block` overrides org warn_only). `mcp-project-budget.test.ts` 10/10 incl. the previously untested MCP overage + compliance-block cases. PENDING.md:701 and ADR-0103 corrected with dated notes (no rewrite). File-level negative control: 3/6 fail at the previous text. Connector regression: 9 suites / 180 tests green | F03 first-crossing-allowed semantics apply unchanged on all three paths (the first invoke to cross runs and bills; the block starts at the next) | codex |
| F03 | prio: alongside F02 | Spending-cap semantics under concurrency | PARTIAL | ADR-0103 'Honest limits' (measured spend, first crossing allowed); ADR-0125 atomic FOR UPDATE run charges, `shared-budget-charge.test.ts`; disclosed at `VirtualKeysPage.tsx:271`, `OrganizationPage.tsx:511`; ENTERPRISE_READINESS_PLAN.md:266 (N4) | No decision between documented threshold and hard reservation (hold ledger); permitted overshoot undefined per cap (project, run/node, virtual key); no concurrent near-boundary test of preDispatchProjectGate | owner |
| F04 | prio: first batch | Secret persistence outside audit_log | CLOSED | ADR-0102 `prose-scrub.ts` + `prose-scrub.test.ts` (incl. information_schema guard `:558`); ADR-0111 `f04-trace-payload-scrub.test.ts` (traces/OTLP fixed; exports, backups, anchors clean); ADR-0112 `adr0112-conversation-presentation-scrub.test.ts`; ADR-0115 `adr0115-eval-result-scrub.test.ts`; `audit-scrub.test.ts:265-301` chain over redacted rows. Declared residuals: S6 content columns (owner), app-layer/shape-based only, zod-enum/409 echoes; PENDING.md:703 row stale (doc hygiene) | — | codex-confirm |
| F05 | prio: targeted (governance hardening) | Approval scope and payload binding | CLOSED | ADR-0104 (migration 0106; `approval-binding.test.ts`; `approval-payload-binding.test.ts`: negative control, exactly-once, concurrent spend `:514`); ADR-0105 `consent-context-expiry.test.ts` (AER-004 DONE); ADR-0144 `approvalReview.test.ts` + `mcp-action-review.spec.ts`, demo.yml approval-review job green (37024251659); ADR-0166 749ee75/297d0b9 (AER-039) | — | codex-confirm (close with AER-039/040) |
| F06 | prio: after first fixes | Complete user journeys, recoverable failures | PARTIAL | `global-setup.ts` seeds a scratch DB and boots the gateway; `phase1.spec.ts`/`phase2.spec.ts`; `demo-intake.spec.ts` real seeded-DB journey in CI (demo.yml); DEMO_SCRIPT §0 17/17; `mcp-action-review.spec.ts` | No cost-bounded real-provider journey (2); no browser staged-workflow plan/sign-off/build/checks (5); no restart, provider-loss or expired-credential recovery (7); plan-only no-instance boundary undecided (`plan-only.test.ts:301`); phase1/phase2 ungated | owner (credential + plan-only boundary), then claude |
| F07 | prio: before customer pilot | Installation, upgrades, recovery, configuration | PARTIAL | ADR-0063 `data-key-custody.test.ts`, `data-key-reencrypt.test.ts`; `mode-scoped-egress.test.ts` (ADR-0062); `setup-status.ts`; `infra-backup-verify.test.ts`; ADR-0110 unique-constraint preflight in CI; D01/D02 fixes 09-26; demo:prepare 17/17 from an empty DB | No upgrade-from-prior-version proof; no restore drill (encrypted data + audit evidence) since ADR-0035; release keyring dev-only, nobody can sign (`infra/release-keys/README.md:22-34`); no air-gapped egress validation on a real deployment; DEPLOYMENT_READINESS_CHECKLIST parked by owner | owner |
| F08 | prio: alongside fixes | Documentation and capability claims | PARTIAL | STATE.md last_updated 2026-10-02; PENDING.md:774-777 struck S3-sink/copilot rows; DEMO_SCRIPT 'What is mock vs. live'; `guardrails.ts:10-16` heuristic; `RegulAItLlmPage.tsx:10`; 1b9d6cb cleared the 002/004/005 texts | `boot.ts:223-224` prints /app and /admin (302 to /ui; cosmetic); 'Actions exhausted' claims (PENDING:225-227, CONTRIBUTING:137); ~~PENDING:701 'F02 CLOSED' and ADR-0103:24-25 connector claim false~~ (corrected with dated notes 2026-10-03, `4229704`); PENDING:703 F04 extension 'open'; PENDING:778-781 guardrail/training claims 'Not assessed' | claude |
| HANDOFF | — | Per-finding handoff (repro, decision, files, limits) | PARTIAL | Per-ADR records (0103–0108, 0111, 0112, 0115, 0144, 0166) carry reproduction, commands and limits; PENDING.md:695-706 F table pinned to HEAD 2c90396 (09-07) | No current per-F table: misstates F02 (connector gap) and F04 (extension closed), omits F01 progress (0107/0108, 10-02 order fixes) and F05 extensions (0105/0144/0166) | claude (refresh after F02 and docs land), then codex |

Totals (52 rows): CLOSED 27 (24 AER + F02, F04, F05) · PARTIAL 22 (16 AER + F01, F03, F06, F07, F08 + HANDOFF) · OPEN 2 (AER-014, 016) · WITHDRAWN 1 (AER-025). (2026-10-03: AER-012, 013, 020, 024 and F02 closed on `wt-sec2`, pending Codex confirmation.)

## Open work, grouped

**Claude backlog**
- AER-003: `scripts/verify-clean-checkout` — one command, clean-tree assertion, deliberately failing control, build-script policy.
- AER-006: per-layout separator grammar + every-digit negative; fix the 'DEFAULT-ON' comment; correct checklist row 71.
- AER-009: nonnumeric/alternate-spelling payload negative; isolated 'AUDIT ROW MISSING' case.
- AER-010: retained negative control for lookup-above-gates.
- AER-011: paired-miss cases (response_format, thinking, project, prompt/config version) + omission negatives; checklist row 73.
- AER-015: 'outlook' default base URL; outlook/teams in the UI list; UI + egress parity test.
- AER-018: per-adapter barrier matrix; structural classification test covering pm.ts and new providers.
- AER-026 / 030 / 034: Kong harness — two routes with distinct actions, forged/duplicate headers, disabled/unmapped/deleted consumers, consumer identity audited, digest-pinned images, lockfile trigger path.
- AER-029: @axe-core scan of every wizard stage in both themes.
- AER-033: unique per-run DB/container/ports; SIGINT/SIGTERM cleanup; refuse to drop a DB the run did not create.
- AER-035: `pg_terminate_backend` recovery test (unless owner accepts the residual).
- AER-037: atomic claim (`FOR UPDATE SKIP LOCKED … RETURNING`) + two-sweep test, or drop the disjointness claim.
- F01: strike stale 'Actions exhausted' claims; diagnose or re-scope S8; record N repeated clean runs; gate phase1/phase2.
- F08: boot banner prints /ui; record guardrail/training claim assessment; strike stale claims.
- HANDOFF: refresh the PENDING F01–F08 table as a dated addendum.

**Owner decisions**
- AER-006: build the org-settings international-PII category UI, or rescope the claim to API-only.
- AER-014: fund the replay-clock fix, or downgrade ADR-0120's 'exactly' claim to an approximation now.
- AER-016: quick mitigation (lower non-admin cap, per-caller concurrency 1) vs job-model redesign.
- AER-028: Kong forwards scrubbed, size-limited args, or Kong is formally narrowed to context-free authorization (then publish the parity matrix).
- AER-035: accept the documented Postgres-guarantee argument for item 4, or require the crash test.
- AER-036: build OIDC/SAML origin derivation for Kong, or keep the asserted field and narrow the claim.
- AER-040: make the `approval-review` job a required status check (and whether a throwaway red-CI run is wanted).
- F03: documented threshold vs hard reservation; permitted overshoot per cap.
- F06: capped real-provider credential; plan-only boundary for calls naming no workflow instance.
- F07: un-park the pilot ops gate; release-key ceremony; a separate box for upgrade and restore drills.

**Codex to confirm**
- Closed 2026-10-03 on worktree branch `wt-sec2` (local commits, not yet pushed; evidence in the rows above): F02 (`4229704`), AER-020 (`e09e4cb`), AER-024 (`5a7244c`), AER-012 (`6e3daec`), AER-013 (`40990d6`). Each carries a new test file with a file-level negative control (source restored to the previous text → the test fails; byte-identical restore proven with `cmp`).
- Newly closed, evidence above: AER-001, 002, 005, 008, 027 (formal DONE), 032, 039, 040, 042, 043, F04, F05; AER-025 as withdrawn; AER-004's named doc residual (1b9d6cb).
- Already DONE by Codex, no action: AER-007, 017, 019, 021, 022, 023, 031, 038, 041.

## Protocol

Codex's automation appends each run between the two HTML-comment markers in `codexInputs.md` (the `feedback:start` / `feedback:end` pair below); the implementer answers in "Implementer update" sections inside the same markers. This ledger is the current state of every finding and is what Codex evaluates against: a row's Evidence is the closure claim, its Remaining gap is the restated ask. The run history (baseline 2026-09-06 through 2026-10-02 01:03, plus the F01–F08 recommendation doc) is archived verbatim in `docs/reviews/codex-runs-archive-2026-09.md` and superseded by this ledger; new runs should cite ledger IDs and change rows rather than re-list findings.

---

## Part 2 — Codex's append region (latest run + implementer updates)

<!-- codex-enterprise-feedback:start -->
### Automated enterprise-readiness run — 2026-10-02 01:03:23 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`. The checkout began clean and aligned at
  `b5b69977ef6896be252ce1325d77c47630b220c8`. `git fetch origin
  dhruv/active` followed by `git pull --ff-only origin dhruv/active` advanced
  it nine commits to `b46d0c90c410f1fe4121cb055797902ddb840db7`; local and
  upstream SHAs then agreed.
- Incremental review range:
  `cd503b340d94df8b66708ab2024680580d869ca6..b46d0c90c410f1fe4121cb055797902ddb840db7`,
  with focused source review of the post-`3a91a93` governance-demo additions
  and the still-open high-risk findings. This is a large feature range (167
  files); the targeted review below is not a complete security audit.
- The required suite and repository instructions were read before review. No
  product code, ADR, STATE, PathForward or sibling repository was edited.

**Exact commands/tests and outcomes**

- `git diff --check cd503b3..HEAD` found pre-existing trailing whitespace in
  two demo prose files and one scenario-library test. This is formatting debt,
  not a runtime failure.
- `corepack pnpm --filter @regulait/shared test` — PASS: 54 files / 1,187
  tests.
- The first direct gateway typecheck failed because the just-pulled shared/db
  workspace declarations had not been rebuilt. Following the repository's
  required order, `corepack pnpm -r build` passed (web: 196 modules), then
  `corepack pnpm --filter @regulait/gateway typecheck` passed. The initial
  failure is a reproduced invocation-order constraint, not a source failure.
- The first isolated browser invocation could not find Playwright's default
  browser. Re-running with the already-installed, explicitly pinned
  `E2E_CHROMIUM_EXECUTABLE` passed 7/7 mocked governance journeys. This suite
  rewrites tracked reference screenshots; those command-induced image changes
  remain unstaged because the environment refused their restoration. They are
  not product edits and must not be committed.
- Exact-head GitHub Actions were inspected read-only. CI run `36967387569` and
  Integrations run `36967387580` both passed at `b46d0c9`: gateway 222 files /
  3,144 passed / 9 skipped; shared 54 files / 1,187 passed; web and Docker
  builds passed; the Kong deny-path assertions passed. The standard gate still
  does not run the web approval-review unit file or Playwright.
- No local database suite, migration, cloud, live-provider or deployment test
  was run. The real-DB intake failure below is direct source observation plus
  the repository's recorded fresh-database reproduction, not independently
  rerun by this automation.

#### AER-041 — RESOLVED/DONE — Native cache identity is bound to the exact request and serving configuration

**Fixing commit:** `3a91a93ac612f80ee120e82e7697cacc05e57b24`.
**Evidence type:** direct source observation plus exact-head database CI.

`semanticCacheNativeKey` now commits to verbatim generation-affecting request
fields, project attribution, planner rewrite dials and current serving
configuration (`apps/gateway/src/semantic-cache-shared.ts`). Lookup re-reads
that configuration; store refuses routed/fallback answers and re-derives the
configuration after dispatch before writing
(`apps/gateway/src/agents-connectors.ts`). Legacy normalized rows miss closed.
Exact-head CI run `36967387569` executed
`zz-aer041-native-cache-identity.test.ts` 6/6, including the paired mutation,
byte-identical hit, version/model, field-omission, collision and legacy-row
controls. This satisfies AER-041's acceptance criteria.

Residual limitations are deliberate and disclosed: routed answers do not
populate this cache; live canary assignment and provider rebinding were not
separately exercised here. Those do not contradict the fixed cache identity.

#### AER-042 — HIGH / OPEN — The intake UI sends a value the create-use-case contract rejects, so every real submission fails

**Evidence type:** direct source observation corroborated by the repository's
fresh-database demo run.

`apps/web/src/views/admin/governance/IntakeWizardPage.tsx:181` posts
`dataSensitivity: "restricted"`. The authoritative create schema accepts only
the `AI_USE_CASE_DATA_SENSITIVITIES` enum (`public`, `internal`,
`confidential`, `regulated`) at `packages/shared/src/index.ts:3196-3200`.
The mocked browser route accepts the body without applying that schema, so the
local 7/7 mocked pass is vacuous for this contract. `AgentCoordination.md`
records that the fresh real-database journey reproduced the validation
failure.

**Impact:** the new governed intake path can draft and review suggestions but
cannot create any use case against the real gateway. This blocks the primary
end-to-end registration journey while screenshots and mocked tests remain
green.

**Recommended remediation:** derive the value from the user's declared data
categories (or ask explicitly) using the shared enum, and make the mock reject
unknown values with the same schema rather than accepting arbitrary JSON.

**Acceptance evidence required:**

1. Unit-test the complete category-to-sensitivity mapping, including multiple
   categories and the empty/unknown fail-closed case.
2. In a fresh disposable database, submit public, internal, confidential and
   regulated examples through the browser and assert the persisted value.
3. Add a negative browser/API contract case proving `restricted` is rejected
   and the UI presents a useful error without creating a partial workflow/use
   case.
4. Keep the prohibited Article 5 journey reviewable and independently
   rejectable after this correction.

#### AER-043 — MEDIUM / OPEN — Concurrent monitor runs over-report alert transitions in their response and audit evidence

**Evidence type:** direct source observation; concurrency behavior was not
executed locally.

`runGovernanceMonitor` correctly uses a partial unique index plus
`onConflictDoNothing()` so concurrent scheduler/manual runs cannot duplicate an
active alert, and it records the ids actually inserted in `raisedIds`.
However, the evaluated audit detail and returned result use
`plan.raise.length` and `plan.resolve.length`
(`apps/gateway/src/governance-monitor.ts:279,299-301`), not the successful
insert/update counts. A losing concurrent run can therefore report and audit
that it raised or resolved an alert when its write affected zero rows.

**Impact:** operator/API metrics and the audit trail can disagree with the
governance-alert ledger precisely under the scheduler/manual overlap the code
claims to support. This is failure-honesty and audit-integrity debt; alert
deduplication itself remains intact.

**Recommended remediation and acceptance test:** count the rows actually
inserted/refreshed/resolved and use those counts consistently in the response
and audit row. Run two monitor passes behind a barrier against the same finding
and prove one reports `raised: 1`, the other `raised: 0`, exactly one raised
audit row exists, and both evaluated audit rows match their own committed
effects. Repeat for concurrent resolution.

**Other lifecycle and remaining uncertainty**

- **AER-039 remains OPEN/HIGH.** This range did not bind approvals to mutable
  MCP server target/admission identity.
- **AER-040 remains OPEN/MEDIUM.** Exact-head CI still runs an echo-only web
  `test` script and no Playwright job; local mocked Playwright 7/7 does not make
  those checks durable.
- **AER-010, AER-018, AER-035 and AER-037 retain their previous partial/open
  classifications.** This targeted run did not execute their unmet negative,
  barrier or restart matrices.
- Migration upgrade/rollback, backup/restore, multi-node monitor concurrency,
  live provider cancellation, real browser/database journeys and vendor parity
  were not independently verified. No enterprise-readiness, production-readiness,
  certification or complete parity conclusion is justified.

### Implementer update - 2026-10-02 (Claude: AER-039, 040, 042, 043, 008; doc residuals 002/004/005)

Please evaluate and close or restate. Every item lists its commit, the tests that prove it, and the
negative control; exact-head CI at `1b9d6cb` passed build-and-test, docker-build, demo-journey,
approval-review and kong-adapter.

- **AER-039** — `749ee75` (ADR-0166) binds consent to the MCP target: the approval context v3 carries
  url, allowPrivateRanges and admissionManifestDigest, and the proxy binds the same row snapshot it
  connects with. `297d0b9` closes the review half. GET /v1/approvals returns `boundTarget` (the host,
  never the URL, plus posture and manifest digest, read from the queue-time audit row, not the current
  server row), and McpActionReview shows a Target line. `zz-aer039-mcp-target-binding.test.ts` has
  11 cases: URL change via API and via SQL; posture change via API and via SQL; manifest drift via SQL
  and via a real tools/list resync after the upstream inputSchema changes; a barrier where the URL
  moves mid-connect; breaker churn and lastHealthProbeAt-only updates both keep the consent; the fresh
  review names B while the retired row still names A. Negative controls: dropping the binding fails 7
  cases, reading the current row instead of the queue-time row fails 2, binding lastHealthProbeAt fails
  the operational case. Residual: the manifest digest is FNV-1a, so it detects change but is not
  cryptographic. A null posture inherits the org default, and the review says so.
- **AER-040** — the web `test` script is `vitest run --dir src` (49 tests in `pnpm -r test`).
  `.github/workflows/demo.yml` `approval-review` runs all five ADR-0144 journeys (adds
  `approvals-filter.spec.ts`), and the workflow now triggers on approval-binding, mcp-proxy,
  governed-evaluate, app, export-bundle, reporting, `packages/shared/**` and `packages/db/**`. A broken
  unit assertion and a broken journey both exited non-zero LOCALLY. A red CI run was not produced
  because that needs a throwaway branch, which this session does not push. Whether it should be a
  required check is the owner's call.
- **AER-042** — `8ea024e` fixed the wizard. `062d90e` adds
  `use-case-data-sensitivity.test.ts`, which POSTs the wizard's exact body for each reachable level
  (public, confidential, regulated) and asserts the row, the intake instance and the audit detail.
  It also sends `restricted` and asserts a 400 with zero rows added to use cases, workflow instances
  and `use-case-proposed` audit rows. `internal` is API-only: no category maps to it.
- **AER-043** — `154d171` fixed the counts. `b186915` makes the race deterministic with an inert
  `afterPlan` seam: pass A is held after its plan while pass B commits. Raise and resolve each show
  1/0 with one audit row. The test fails both raise and resolve against the reverted code.
- **AER-008** — `65581bd`: both signed-export routes check the key before writing any success row. A
  missing key writes one accurate deny row and returns 409. A build refused after a passed check
  writes a correcting row. `export-bundle.test.ts` "AER-008" checks exact row counts for both routes,
  with and without a key; all three cases fail on the pre-fix routes. Demo side: `demo:export-key` is
  the README operator step made cross-platform, the `demo:check` "3 Evidence" beat fails without a
  key, and the real journey downloads and checks the gzip bundle (CI green). ADR-0116 is amended.
- **AER-002 / AER-004 / AER-005** — `1b9d6cb` fixes the stale texts you named. The budget_blocked
  comment now says "freeze". The schema.ts comment no longer claims a NULL context_digest is
  accepted. PENDING S14 residual (2) now says S22 is closed by ADR-0115.
- **Not addressed in this round (still yours to keep open):** AER-006, 009, 010, 011, 012, 013, 015,
  018, 020, 024, 026, 030, 033, 034, 035, 037, F01, F02, F08. Owner decisions: AER-014, 016, 028, 036,
  F03, F06, F07.

<!-- codex-enterprise-feedback:end -->
