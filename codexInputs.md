# Codex review findings and implementation handoff

This file has two parts. **Part 1** is the status ledger: one row per finding (AER-001..049, the
2026-09-06 F01..F08 recommendations), its current status with evidence, and who acts next. It is the
authoritative current state; Codex evaluates and confirms closures here. **Part 2** is Codex's
append region: the latest automated run and the implementer updates it answers. Earlier runs
(2026-09-06 .. 2026-09-30) and the original F01..F08 recommendation document are preserved verbatim
in `docs/reviews/codex-runs-archive-2026-09.md`.

## Status ledger — current state of every finding

Date: 2026-10-03. Branch `dhruv/active`, reviewed HEAD `dbbb642`.
Basis: the adversarially verified audit of every item at HEAD `21b3094` (auditor + verifier; verifier wins on disagreement), plus today's post-audit fixes, each confirmed in `git log`: `65581bd`, `749ee75`, `297d0b9`, `b5418e8`, `8ea024e`, `062d90e`, `154d171`, `b186915`, `1b9d6cb`.
Status: CLOSED = acceptance met per audit or by a listed fix; PARTIAL = materially improved, a named criterion unmet; OPEN = otherwise; WITHDRAWN = not applicable.
Next: `claude` (code/doc work) · `codex-confirm` (closure to be acknowledged by Codex) · `owner` (decision needed).

| ID | Severity (original) | Title | Status | Evidence | Remaining gap | Next |
|---|---|---|---|---|---|---|
| AER-001 | HIGH | MCP budget gate without ADR/adversarial tests | CLOSED | ADR-0103; `mcp-project-budget.test.ts` (77692dc: direct, proxy-route and delegated-worker refusal, zero upstream/billing, unpriced block, warn_only, null-project); `compliance-cost.test.ts:107` (profile block overrides org warn_only); runs in the green gateway CI suite | — | codex-confirm |
| AER-002 | MEDIUM | 'Paid tool calls' wording vs freeze predicate | CLOSED | 414c006 (ADR-0103 amendment: "project dispatch FREEZE", 0103:194); `mcp-project-budget.test.ts:232`; 1b9d6cb rewords the `mcp-proxy.ts:251` comment | — | codex-confirm |
| AER-003 | MEDIUM | Clean-checkout verification not reproducible | CLOSED | 2026-10-03: `scripts/verify-clean-checkout.sh` (6a0e404, 46231be) — one pinned command (corepack pnpm 10.33.0, frozen install, build, typecheck, disposable-DB suite, CI's ADR-0110 and UI-affordance pre-flights), asserts `git status --short --untracked-files=all` is empty, refuses a dirty start; `--prove-failure` runs the script itself in a dirtied clone and requires a non-zero exit (a mutation that deletes the final assertion fails the control); `pnpm.onlyBuiltDependencies: []` plus an assessed ignore list, so a fresh install is silent · earlier: README.md:85-140 pinned sequence (corepack pnpm@10.33.0, `--frozen-lockfile`, build, `tsc --noEmit`, disposable-DB tests, preflight); ci.yml:105-112 frozen-lockfile | The full stage-4 run (whole suite) is exercised by the dispatcher gate, not by the script's own control | codex-confirm |
| AER-004 | HIGH | Approval consent not policy-bound, no expiry | CLOSED | 7b44da6 (Codex DONE 09-30); migration `0119_approval_policy_epoch`; `governed-evaluate.ts:230`, `mcp-proxy.ts:263-274`; `consent-context-expiry.test.ts` (15); 1b9d6cb fixes the `schema.ts:1307` comment (NULL digest is not spendable; epoch lock described) | — | codex-confirm |
| AER-005 | MEDIUM | ADR-0115 evidence; PENDING said S22 unassessed | CLOSED | ADR-0115; `adr0115-eval-result-scrub.test.ts` in CI; PENDING.md:162 closes S22; 1b9d6cb rewrites PENDING.md:155-156 (S22 assessed and closed, at-rest caveat kept) | — | codex-confirm |
| AER-006 | MEDIUM | International PII grammar, missing admin UI | CLOSED | 2026-10-03: explicit published layouts per scheme, no separator after every digit (5b61d1b); BSN 4.2.3 and CPF 9-2 restored after review (93317d7); vector set 2026-10-03.2 = 39 positives / 50 negatives / 9 misses, every new negative checksum-valid; DEFAULT-ON comment corrected; TESTING_CHECKLIST row 71 says API-only; ADR-0117 amended · earlier: `pii-international.ts:568` `DEFAULT_INTERNATIONAL_CATEGORIES = []` (default-off held); conformance suite wired | UI vs API-only remains an owner decision | codex-confirm (UI: owner) |
| AER-007 | HIGH | Non-admin signed bundles leaked org audit | CLOSED | b9df6d0 (Codex DONE 09-30); `reporting.ts:959` auditPayloadScope 'subject'; `export-bundle.test.ts:429-457` unrelated-sentinel isolation | — | codex-confirm |
| AER-008 | MEDIUM | Missing signing key left false success rows | CLOSED | 65581bd: key preflight before any success row (`app.ts:3990`, `reporting.ts:910`), accurate deny row on refusal, correcting row after a failed build; `export-bundle.test.ts` "AER-008" exact row deltas for both routes (all 3 cases fail pre-fix); `demo-export-key.ts` + `demo:export-key`; `demo-check-lib.ts` "3 Evidence" beat; `demo-intake.spec.ts:173-176` clicks and asserts the gzip bundle; ADR-0116 amendment (2026-10-02); DEMO_SCRIPT §0 | — | codex-confirm |
| AER-009 | MEDIUM | Offline verifier ignored unlisted audit rows | CLOSED | 2026-10-03: AUDIT PAYLOAD NAME MALFORMED for non-numeric and alternate-spelling names, and an isolated listed-payload-removed case asserting AUDIT ROW MISSING with the chain intact (88e1bdf); review found symlinks/FIFOs under the bundle verified clean — now NON-REGULAR ENTRY IN BUNDLE, refused before the signature check (1358703); export-bundle.test.ts 34/34, previous verifier fails; ADR-0116 amended · earlier: `verify-export-bundle.sh:333-361,452-458` derives the payload set from chain.tsv; `export-bundle.test.ts:643-652` 'unlisted audit payloads' | — | codex-confirm |
| AER-010 | HIGH | Cache hits bypassed shared dispatch gates | CLOSED | 2026-10-03: retained reference-based structural control in adr0119-compat-semantic-cache.test.ts (78adb86, 7f814b3): every read of cachedResponse in dispatchAttempt must sit after the last gate and each gate's refusal return; at both lookup sites every reference to the hit is the `if (hit)` test or the `cachedResponse: hit` argument; the reviewer's five dispatch-core mutations and `hit?.outputText` at both sites all fail the new test and passed the old one; behavioural PII-tightening case (7527e98) · earlier: b33de7c routes native and compat hits through the governed-dispatch core; `adr0119-compat-semantic-cache.test.ts:267-423` prime-then-tighten matrix | A serve-on-deny after the core call is left to the behavioural matrix by design | codex-confirm |
| AER-011 | HIGH | Compat cache key not request identity | CLOSED | 2026-10-03: paired-miss DB tests for response_format, thinking, project, prompt/config version, surface, cache_control and model string; omission controls run for all 18 committed compat fields and retained as a structural ledger test (78adb86, 115bacd); TESTING_CHECKLIST row 73 corrected with a step per claim (9367e41, 4c93f93). Ledger evidence path corrected: semantic-cache-shared.ts lives in apps/gateway/src · earlier: aa1e1b9 canonical SHA-512 commitment + collision guard (`semantic-cache-shared.ts`); `compat-core.ts:945-954` commits responseFormat/thinking/maxTokens/projectId/system/versions; adr0119 tests `:237-265`, `:424` | Owner question: compat commits cacheSystem while native leaves prompt caching out (PENDING) | codex-confirm |
| AER-012 | MEDIUM | Posture endpoint never calls Object Lock observe() | CLOSED | `6e3daec` (2026-10-03, `wt-sec2`): `buildPostureReport` is async on the LONG-LIVED sink — `registerPosturePresetRoutes(app, db, { sink })` receives `buildApp`'s `auditAnchorSink` (resolved once at registration otherwise, never per request) and awaits `observe()`, reporting `current.lockMode` + `disclosure` beside the grade; the harden response's posture goes through the same path. `aer012-posture-anchor-observe.test.ts` 10/10: COMPLIANCE (true) / GOVERNANCE / no-Object-Lock / errored probe / anchoring-off apps over the audit-chain tests' fake S3 transport, GET + harden assertions, probe counts proving the cached observation is reused and a failed probe is never cached, null-sink negative control. File-level negative control: 9/10 fail with `posture-preset.ts` + `app.ts` at the previous text. `adr0118-hardened-posture.test.ts` 14/14 (unit-level calls now await), `posture.test.ts` 11/11, `audit-chain.test.ts` 57/57 (+9 MinIO-skipped) | — | codex |
| AER-013 | MEDIUM | Hardened preset mutation/audit not atomic | CLOSED | `40990d6` (2026-10-03, `wt-sec2`): harden follows ADR-0132 — `loadOrgSettings` initializes the singleton, then `db.transaction` locks it `FOR UPDATE`, idempotency is decided against the locked committed row, the update `RETURNING` the row the report is built from and both audit rows (`org-posture-hardened`, `mrm-enforcement-enabled`) commit together or not at all; groups validated before the tx (non-array → 400 `invalid_posture_groups`, unknown refuses the whole request, duplicates de-duplicated). `aer013-harden-atomicity.test.ts` 7/7: 12 concurrent applications → 1 applied + exactly 1 audit row per fact; BEFORE INSERT trigger rejecting the preset's row → 5xx, settings/ledger/updatedAt unchanged, same request applies once the injection is removed; retry no-op incl. updatedAt; empty/duplicate/unknown/non-array groups. File-level negative control: 3/7 fail at the previous text (rollback, duplicate de-dup, non-array) | Disclosed: the 12-way concurrency case passed on the old code too (`app.inject` did not race the old read/update window), so it pins the invariant rather than discriminating the old code; the rollback case is the discriminating one | codex |
| AER-014 | HIGH | Rate-limit simulation uses present-time counter | OPEN | `policy-simulation.ts:358` no replay time; `governed-evaluate.ts:437` window from `Date.now()`; ADR-0120:123 'exactly' claim unqualified | All unmet: replay clock, strictly-before counting, 'indeterminate' on truncated lookback, two-per-hour ordered test, `Date.now()` negative control | owner (replay-clock fix vs downgrade ADR-0120 claim) |
| AER-015 | MEDIUM | Outlook adapter not creatable via product | CLOSED | 2026-10-03: the outlook default base URL was already present (4462cde) and is now pinned; outlook/teams in the admin kind list, UI-vs-egress parity test, strict-egress outlook e2e (4025097); ChatOps offers outlook from a pinned mirror and the credential card names the JSON shape (344ba36) · earlier: create schema accepts outlook; `adr0121-outlook-chatops.test.ts` (public-route create; schema/adapter parity `:247-258`); `OUTLOOK_DEFAULT_GRAPH_BASE_URL` (connector-provider index.ts:835) | New gap (PENDING): outlook ChatOps connections register but postCard returns 501 — no outbound outlook branch | codex-confirm |
| AER-016 | MEDIUM | Non-admin preview admits 20k-row N+1 | OPEN | `route-classes.ts:258` non-admin; `shared/policy-simulation.ts:409-412` caps 20k/5k; serial `governedEvaluate` loop `:358` | All unmet: bounded query growth, per-caller/global concurrency, timeout/cancel with honest incomplete state, load instrumentation | owner (quick mitigation vs job redesign) |
| AER-017 | HIGH | require_approval could authorize nothing | CLOSED | dee2e0e (Codex DONE 09-28); `policy-kernel/src/index.ts`; `adr0124-kill-switch.test.ts:494-630` 'AER-017' suite | — | codex-confirm |
| AER-018 | HIGH | Kill switch excluded deploy/Git/infra/PM | CLOSED | 2026-10-03: per-adapter barrier matrix (pause before the real call, flip the mode, resume, counting fake stays 0) across workflows/infra/pm including the cert_rotate decision site (9458d9d, 84c2a7d); structural test enrols files by import over src/**, refuses raw returns in providerFor, treats every contract member but reads as a write and refuses heritage clauses (9b4168b); the reviewer's three bypass mutations now fail · earlier: 8507fa3 `external-effects.ts:4-45` runExternalWrite re-reads the mode before 10 ops; wraps workflows.ts, infra.ts, pm.ts; `external-effects.test.ts` (2 cases) | — | codex-confirm |
| AER-019 | HIGH | Emergency-state and audit writes racy | CLOSED | 1bac371 (Codex DONE 09-30); `execution-control.ts` transactions; `zz-aer019-emergency-atomicity.test.ts` (fault injection, 20-way races, restart reread) | — | codex-confirm |
| AER-020 | MEDIUM | MCP discovery 'redacted' samples leak credentials | CLOSED | `e09e4cb` (2026-10-03, `wt-sec2`): `scrubEvidenceSample` in `packages/shared/src/mcp-discovery.ts` composes the ADR-0099 credential scrubber (`scrubAuditText`, shared rules: AWS/PEM/JWT/assignment/vendor/`rgl*`) + `redactPII` (email/SSN/Luhn card/phone) + the space-separated `Authorization: Bearer|Basic <value>` header shape, applied to the FULL line before the 200-char slice; both scrubbers already live in `@regulait/shared` (no gateway import); `shadow-ai.ts` returns the scrubbed samples unchanged. `packages/shared/src/mcp-discovery.test.ts` 33/33 (11-entry corpus — AWS key, sk-, ghp_, xoxb-, JWT, opaque bearer, Basic, rgl_, api_key=, email, Luhn card — each early on the line AND starting at offset 188 so it straddles the cut, no 8-char window survives; marker shape; identity on a clean line). `adr0122-mcp-discovery.test.ts` 8/8 (preview/apply serialized bodies, the apply audit row and GET /v1/shadow-ai/findings carry no corpus value; verbatim-sample control). File-level negative control: 24/33 shared + 2/8 gateway fail at the previous text. `audit-scrub.test.ts` 20/20, `pii.test.ts` 17/17, `shadow-ai.test.ts` 19/19 | — | codex |
| AER-021 | HIGH | Model deadline omitted Google/Gemini | CLOSED | 4aea3dd (Codex DONE 09-28); AbortSignal.timeout at the provider resolver (`packages/model-provider/src/index.ts`); 132/132 provider tests incl. Google header/body hangs | — | codex-confirm |
| AER-022 | HIGH | MCP breaker guarded only outer handshake | CLOSED | c37c9b9, dd50ab2 (ADR-0129), 1d231e0 (Codex DONE 09-30); `zz-aer022-operation-breaker.test.ts` (6); g2-upstream-deadlines regressions restored | — | codex-confirm |
| AER-023 | MEDIUM | Breaker state/audit transitions non-atomic | CLOSED | 324b231 (ADR-0133; Codex DONE 09-30); `zz-aer023-breaker-atomicity.test.ts` 4/4 (audit fault injection, 20-way races) | — | codex-confirm |
| AER-024 | MEDIUM | Open breaker hides admission/egress refusals | CLOSED | `5a7244c` (2026-10-03, `wt-sec2`): `preflightUpstream` (`assertAdmitted` then `checkMcpServerUrl`, audited exactly as the connect-time guard audits, same error classes, no DNS lookup for a held server, breaker neither read nor elected) runs before breaker election in `executeGovernedToolCall`, before `breakerAdmits` on the route's manifest path, and before the worker-discovery election; the hijacked tools/call maps both refusals to the manifest handler's `Denied by policy` MCP error instead of a generic internal error. `zz-aer024-breaker-preflight.test.ts` 5/5: held and egress-refused servers behind an OPEN breaker — manifest 403 `mcp_admission_held` / `egress_blocked` + own audit row (`mcp-admission-held`, `mcp-server-egress-blocked` phase connect), proxy tools/call + direct primitive named refusal, zero upstream requests, breaker row untouched; admitted server still gets 503 `mcp_upstream_circuit_open`. File-level negative control: 4/5 fail at the previous text, positive control passes. Lift policy unchanged: `g2-upstream-deadlines.test.ts` 13/13, `zz-aer022` 6/6, `zz-aer023` 4/4, `mcp-proxy.test.ts` 152/152, `mcp-admission-auth` 25/25, `mcp-admission-rescan` 16/16, `mcp-oidc-egress` 20/20 | Literal-criterion note: a post-hijack tools/call cannot answer an HTTP 403; it answers the same named policy refusal the manifest handler uses, with the audit row | codex |
| AER-025 | HIGH | Envoy adapter could treat deny as allow | WITHDRAWN | 46590d6 removed the adapter; `integrations/envoy/ext_authz.yaml` is a withdrawal notice; support claims reconciled under AER-031 | — | codex-confirm (close as withdrawn) |
| AER-026 | HIGH | Sample adapters trusted caller subject header | CLOSED | kong-adapter green: Integrations run 37110038871 at `8c0132b` (2026-10-03), 47/47 assertions, digests logged · 2026-10-03: plugin refuses the five protocol header names (any case/copies/underscores), credential-less and unmapped consumers; PDP refuses unknown_subject and subject_disabled and writes both to the ledger with proxyConsumer (1aae7d3, 5bef1fd, 2312d48); ADR-0127 amended · earlier: 46590d6: `handler.lua:149-162` subject from consumer.custom_id, forgeable headers stripped `:51-61,:142`; `verify.mjs:474-480` three x-regulait-subject spellings | — | codex-confirm |
| AER-027 | HIGH | PDP secret was unrestricted admin credential | CLOSED | 46f2919 + migration 0117: closed `dispatch\|pdp` key purpose; a PDP key reaches only POST /v1/authz/check; 9 focused tests in CI; Kong harness mints a purpose 'pdp' key | — | codex-confirm (formal DONE) |
| AER-028 | HIGH | Callout omits args, project, principal | PARTIAL | endpoint accepts args/projectId/principal (46f2919; `app.ts:2147-2195`; `aer028-callout-context.test.ts`); Kong sends static per-route project + derived/asserted origin (4f12c84) | Kong build_question sends no args (`handler.lua:83-89,:119-132`) so data-scope rules always deny; OIDC/SAML origins asserted; callout never binds/consumes approvals; no parity matrix | owner (forward scrubbed args vs narrow Kong to context-free authz) |
| AER-029 | MEDIUM | Guided intake controls lacked accessible labels | PARTIAL | 2026-10-03: `intake-a11y.mock.spec.ts` contains an @axe-core/playwright scan of every wizard stage in both themes plus blocking/error states, with fixes in 7ae85b8/248163a and Fieldset unit coverage in 71630d8. Exact-head CI `37120058343` passed web 12 files / 95 tests and the 39 phase1/phase2 journeys, but its commands did **not** execute `intake-a11y.mock.spec.ts`; the latest executable axe evidence remains repository-reported, not independently reproduced or gated. **Update 2026-10-03:** `6da2627` adds a "Mocked UI suite" step to CI's spa-journeys job (`playwright test -c playwright.demo-mock.config.ts`, every `*.mock.spec.ts`); CI run `37125215948` at `40f7f2c` executed it green, including `intake-a11y.mock.spec.ts` | The gap named above (no exact-head CI execution) is closed by run `37125215948`; for Codex to confirm from that run, including that the failing control still turns it red | codex-confirm |
| AER-030 | HIGH | Kong adapter not runnable; one action per route | CLOSED | kong-adapter green: Integrations run 37110038871 at `8c0132b` (2026-10-03), 47/47 assertions, digests logged · 2026-10-03: two routes bound to distinct server/tool pairs, forged binding and decision headers refused, VERSION set (2ecfcb6, 2312d48) · earlier: custom plugin with per-instance server_id/tool_name runs in the CI Kong job (integrations.yml) | Coverage is Kong 3.6 + DB-less + key-auth only (disclosed) | codex-confirm |
| AER-031 | MEDIUM | Envoy withdrawal not reconciled in claims | CLOSED | b8e9720 (Codex DONE 09-27); docs/deployment/README.md:17 | — | codex-confirm |
| AER-032 | MEDIUM | Disabled destructive controls hid reason from AT | CLOSED | `adminKit.tsx:213-245` RemoveButton aria-disabled + focusable reason; blocked-reason-a11y spec `:55-85` (Tab, Enter, Escape, focus return). Minor: spec covers 1 of 8 disabledReason sites via the shared component | — | codex-confirm |
| AER-033 | HIGH | Kong harness left admin key world-readable | CLOSED | kong-adapter green: Integrations run 37110038871 at `8c0132b` (2026-10-03), 47/47 assertions, digests logged · 2026-10-03: per-run DB/container/ports, ownership-checked teardown on exit and on SIGINT/SIGTERM with an aborting flag, non-runner key-location canary (0a103d8, 2312d48) · earlier: HIGH exposure fixed: pdp-purpose key, vault reference, 0700 mkdtemp (`verify.mjs:183,225-227`), finally revoke/rmSync/DROP `:608-627` | — | codex-confirm |
| AER-034 | MEDIUM | Kong verification claim exceeds its gate | CLOSED | kong-adapter green: Integrations run 37110038871 at `8c0132b` (2026-10-03), 47/47 assertions, digests logged · 2026-10-03: kong and postgres pinned by digest and logged, pnpm-lock.yaml in the trigger paths (4970d69); docs say "pending first CI run" instead of verified (8c1caa5) · earlier: b8e9720 approval_required / non-200 / unparseable cases (`verify.mjs:481-512`); integrations.yml paths include apps/gateway/src/** and packages/** | — | codex-confirm |
| AER-035 | HIGH | Copilot apply not concurrency-safe/atomic | CLOSED | 2026-10-03: pg_terminate_backend on the applier mid-transaction, then one re-apply: exactly one applied state and audit sequence, partial write proven rolled back, and the test counts uncaught errors itself (e5982a2, 348da13); REL-01 widened to checked-out clients (f3b4211) · earlier: 946ba2c, f203e7c, f587c5f: one FOR UPDATE transaction, 20-way races (4 kinds), trigger-injected fault at the last audit write; `zz-aer035-apply-atomicity.test.ts` | — | codex-confirm |
| AER-036 | HIGH | Kong could label API-key traffic as SSO | PARTIAL | 4f12c84 `derive_session_origin` (`handler.lua:112-117`) api_key/password from the credential, contradicting assertion refused; harness asserts the exact origin (`verify.mjs:540-566`) | OIDC/SAML origins remain operator assertions (`:177-183`); no per-request derivation; no mixed-auth / ambiguous-metadata tests | owner (build OIDC/SAML derivation vs narrow the claim) |
| AER-037 | MEDIUM | Capped health sweep starved the tail | CLOSED | 2026-10-03: one-statement claim (FOR UPDATE SKIP LOCKED … RETURNING) serialized by pg_advisory_xact_lock(6_000_000_037) in a short transaction (e0fc0b7, 79b0d3d); deterministic interleaving test (claim A open, claim B started, A commits) proves disjoint sets and fails on the previous code · earlier: 7b3e9b0 lastHealthProbeAt rotation, broken-first queue, backlog reporting (`mcp-health-probe.ts:193-250`) | — | codex-confirm |
| AER-038 | HIGH | Retry from readOnlyHint could duplicate execution | CLOSED | `attemptsForToolKind` always 1 (Codex DONE 09-30); `zz-adr0128-upstream-retry.test.ts` durable-effect regression | — | codex-confirm |
| AER-039 | HIGH | MCP approvals not bound to server target | CLOSED | 749ee75 (ADR-0166): `approval-binding.ts` v3 digest {serverId, url, allowPrivateRanges, admissionManifestDigest}; `governed-evaluate.ts`; `mcp-proxy.ts:663-667,:703`; 297d0b9: GET /v1/approvals `boundTarget` from the queue-time audit row (`app.ts:2726,2939`), McpActionReview Target line, `approvalReview.test.ts`, `mcp-action-review.spec.ts`; `zz-aer039-mcp-target-binding.test.ts` 11 cases (URL and posture via API and SQL, drift via real tools/list resync, mid-connect barrier, breaker churn and lastHealthProbeAt-only keep consent, fresh review names B); negative controls recorded. Disclosed residual: FNV-1a manifest digest is a change detector, not cryptographic | — | codex-confirm |
| AER-040 | MEDIUM | Approver-review tests outside CI gates | CLOSED | apps/web `test` = `vitest run --dir src` (8ea024e; approvalReview.test.ts runs in `pnpm -r test`); b5418e8 + 65581bd: demo.yml `approval-review` job runs mcp-action-review + approvals-filter specs (all 5 ADR-0144 journeys, demo.yml:205) and the workflow triggers on app/mcp-proxy/governed-evaluate/export-bundle/reporting, packages/shared/**, packages/db/** (demo.yml:26-32); green at 1b9d6cb. Residual (disclosed): red CI for a broken assertion/journey shown locally only (needs a throwaway branch); required-check status is the owner's call | — | codex-confirm (+ owner: required check) |
| AER-041 | HIGH | Native cache identity collapsed requests | CLOSED | 3a91a93 (ADR-0146; Codex DONE 10-02); `zz-aer041-native-cache-identity.test.ts` 6/6 (CI 36967387569) | — | codex-confirm |
| AER-042 | HIGH | Intake UI sent invalid dataSensitivity | CLOSED | 8ea024e: `dataSensitivity.ts` deriveDataSensitivity (strictest wins; empty/unknown fail closed to 'regulated'), `dataSensitivity.test.ts` (4), `IntakeWizardPage.tsx:199`; `demo-governance.mock.spec.ts` 400 on non-enum; `demo-intake.spec.ts:88-91` real-DB persisted 'regulated'; 062d90e `use-case-data-sensitivity.test.ts`: public/confidential/regulated persisted (row, intake instance, audit detail), 'internal' is API-only (no category maps to it), 'restricted' gets 400 with zero use-case/workflow/audit rows | — | codex-confirm |
| AER-043 | MEDIUM | Concurrent monitor runs over-report transitions | CLOSED | 154d171 `governance-monitor.ts`: raised = raisedIds from onConflictDoNothing().returning, refreshed/resolved from rows actually updated; audit detail (`:288`) and response (`:308`) share the counts; b186915 inert `afterPlan` seam (`:91,:220`) holds pass A after its plan while B commits; `zz-aer043-monitor-concurrency.test.ts` (5) asserts raise 1/0 and resolve 1/0 with one audit row each, fails on the reverted code | — | codex-confirm |
| AER-044 | HIGH | Empty deploy-agent selection bypasses intended-agent safety gates | CLOSED / RESOLVED-DONE | Codex confirmed at `dbbb642`: ec68ebc evaluates the approved stack plus requested extras, so omitted, empty and subset selections cannot remove intended agents; 4f7516b loads route evidence for the same union. Exact-head CI `37120058343` passed shared `deploy-gate.test.ts` 14/14 and gateway `zz-aer044-deploy-gate-selection.test.ts` 10/10, including halted, MRM-refused, clean and off-stack cases | Pre-existing optional follow-up only: an approved use case with an empty intended stack checks zero agents | — |
| AER-045 | MEDIUM | Trace evaluation overlap can permanently miss late-completing spans | CLOSED / RESOLVED-DONE | Codex confirmed at `dbbb642`: d6571ff replaces the moving started-at cursor with an anti-join of eligible spans lacking evaluation rows above an installation-anchored floor; conflict-do-nothing returning gives exactly-once accounting. Exact-head CI `37120058343` passed `zz-adr0160-trace-evaluation.test.ts` 7/7, including 11-minute/3-hour late completion, overlapping sweeps and fixed-floor controls | Retention/performance boundary remains disclosed: pre-cutover spans older than the fixed floor are excluded, and the full-history anti-join needs indexing/pruning work | — |
| AER-046 | MEDIUM | Intake retry can mix old persisted artifacts with edited new inputs | PARTIAL | d3409d8 binds each checkpoint to canonical inputs and plans reuse/update/refusal; 89061ee aborts the earlier intake before “start over.” Exact-head CI `37120058343` passed planner 9/9 and real-route contract 2/2. However CI did not execute `intake-retry.mock.spec.ts`, the only acceptance test that drives the fail/back/edit/retry UI and proves all-old/all-new request behavior. **Update 2026-10-03:** CI run `37125215948` at `40f7f2c` executed `intake-retry.mock.spec.ts` green in the new "Mocked UI suite" step (`6da2627`) | The gate gap above is closed by run `37125215948`; for Codex to confirm. Sequential partial-write recovery remains a disclosed product limitation, not silent mixing | codex-confirm |
| AER-047 | HIGH | Missing automated-check reports are converted into passes | CLOSED / RESOLVED-DONE | Codex confirmed at `dbbb642`: unreported checks now remain pending by default; typed offline auto-pass requires template opt-in plus an explicitly offline, non-deployed process and is labelled/audited. Exact-head CI `37120058343` passed workflow-checks 13/13, eval-harness 23/23 and workflow-kernel 45/45, covering explicit fail, partial/missing report, reopen clearing and fail-closed opt-in | The newly isolated concurrency/round-binding defect is tracked separately as AER-048 | — |
| AER-048 | HIGH | Check executor can overwrite concurrent reports or restore stale-round context | CLOSED | 2026-10-03, fixed on `wt-aer48` and merged locally at `7a40d77`: `a0f0d85` (migration 0130: `workflow_instances.round` and `stage_entry`, `org_settings.check_reports_allow_unbound`), `be1f3d9` (the fix), `f54f0a0` (reclassification reapply runs under the instance row lock), `26bfb09` (review fixes). `round` is bumped on every re-open (artifact resubmitted after its stage completed; `approval_returned`); `stage_entry` on every executable-stage entry, including a recheck, and on every re-open. Executor completion goes through `commitStageResult`: `FOR UPDATE`, CAS on stage entry + stage + `awaiting_execution` + claim id, and it merges only the keys the executor changed; a discarded result is audited `workflow:executor-result-discarded` with the effect-record values, and effect records are salvaged under the lock. Reports bind to the round and **fail closed**: a key-authenticated report without `round` is `422 round_required` unless the org setting `checkReportsAllowUnbound` is on (default false, admin-only, audited); a session-authenticated report may omit it (binds to the current round); a stale round is `409 stale_check_report`, audited `workflow:checks-report-stale-round`; a report while another executor holds the claim is `202 deferred_to_running_executor`, and the holder re-evaluates once if reports changed and it did not commit. The PR body carries `regulait-instance:` / `regulait-round:`; external provider writes are audited `external-effect:<op>`; nested-run completion has a precondition and a re-open clears later `runId:<stage>`; the stage span is written after commit. `workflow-check-round.test.ts` 10/10 — cases (1)-(4) are this row's four barrier cases (report-during-eval retained, re-open-during-eval cannot restore or advance, previous-round report refused, overlapping advances apply the outcome once), plus fail-closed binding, a no-race control, deploy/merge discard, throw-after-report and the `runId` clear — with a negative control per fix; full suite 3367 passed (the implementer's run; the dispatcher's full gate on the merged tree `7a40d77` then passed: suite 3367/9 skipped, demo:prepare 18/18, real journey 1/1, mocked UI 54/54, phase1+phase2 39/39, approval-review 4/4). Two independent adversarial reviews: round 1 fix-first (8 findings, all fixed in `f54f0a0`/`26bfb09`), round 2 ship | Round-2 nits, not blocking: a naive CI can resend the echoed `currentRound` (consider an opaque per-round token); the PR body's round goes stale after a re-open (CI should GET `instance.round` at run start); a live old-round nested run is not aborted on re-open; a hard crash after a 202 still waits out the claim TTL; an `applyEvent` precondition-write hazard (safe today). Effect records surviving a re-open past merge/deploy are tracked as AER-049 | codex-confirm |
| AER-049 | SHOULD-FIX (claude-found, 2026-10-03, AER-048 review) | A re-open past merge/deploy reuses v1's effect records, so the instance can complete as shipped when only v1 shipped | CLOSED | 2026-10-03, owner decision (ADR-0168 afternoon amendment item 1: a change after merge or deploy needs a new review round; the number of reviews is configurable), built on `wt-g2-aer049` and merged on `wt-g2-int` at `90cfb1b`: `385631d` (kernel generic `reopen` event, the one event a completed instance accepts), `604158b` (effect records stamped per round in `effects:stamps`; a re-open moves every re-run stage's records into the append-only `effects:history`, audited `workflow:effects-archived`; the new round cuts a `<prefix>/<id8>-r<round>` branch, opens a NEW PR with `regulait-round:` / `regulait-supersedes:`, merges and deploys again; a discarded earlier-round executor salvages into history, never live), `69bb1ad`, `f0adbd2` (the recertification sweep re-opens through `reopenWorkflowInstance`, system actor `system:recertification-sweep`), `a1b679e` (review fixes: the git chain — branch, PR, merge — is archived as one unit; merge refuses a PR its round did not open, audited `workflow:merge-refused-stale-pr`; a `reopen` target must be a sign-off or artifact stage at or before the first PR / merge / deploy / rollback stage, so review always runs again before anything ships; mock / dry-run deploy ids carry the round). Tests (5)/(6) now assert a fresh merge and deploy; `workflow-check-round.test.ts` 17, workflow-kernel 50/50 (incl. refusals for denied / rolled-back instances and for targets past the first shipping stage), gateway full suite 3401 passed. Two adversarial reviews: ship with two should-fixes, both fixed in `a1b679e`. Spec: WORKFLOW_ENGINE_SPEC stages 8, 10, 11 | An earlier round's unmerged PR stays open on the provider (no close operation in the git adapter); `effects:history` is not shown in the UI | codex-confirm |
| F01 | prio: first | Stabilize tests, dependable quality gate | PARTIAL | 2026-10-03: S8 diagnosed and fixed test-side — mcp-proxy.test.ts left platform credentials encrypted under its own key, so compat-longtail got a decrypt 500 instead of 409 (aa7a7a0, 1212462); phase1/phase2 SPA journeys gated in CI (spa-journeys job) and two stale phase2 assertions repaired (152a27d); Actions-exhausted claims withdrawn (dbf7bda, 9b5ced5) · earlier: ADR-0106 `mock-socket-contract.ts` setupFile (vitest.config.ts:14) + exit-code proof (0106:252-275); ADR-0107/0108 unordered-read sweeps; README.md:84-147 pinned sequence; ci.yml `pnpm -r test` on Postgres; exact-head CI 37036782298 green at 21b3094 | Repeated clean full-suite runs being recorded by the dispatcher gate (see implementer update) | dispatcher, then codex-confirm |
| F02 | prio: first batch | Budget enforcement across model/MCP/connector | CLOSED / RESOLVED-DONE | Remote fix `aa233bd` (Codex-confirmed at `9a13e26`): `agents-connectors.ts:5007-5030` calls `preDispatchProjectGate` after entitlement allow and before credentials/PII/egress/provider work, audits `project-budget-cap` and returns without execution. Exact-head CI `37094018095` passed `connector-project-budget.test.ts` 6/6 (exhausted: 409, zero receiver hits and usage; healthy/unattributed/sanctioned/warn-only/profile-override cases) within gateway 239 files / 3,290 tests. `mcp-project-budget.test.ts` also remains green. | F03 first-crossing-allowed semantics remain disclosed: the first invoke to cross runs and bills; blocking starts on the next dispatch | — |
| F03 | prio: alongside F02 | Spending-cap semantics under concurrency | PARTIAL | ADR-0103 'Honest limits' (measured spend, first crossing allowed); ADR-0125 atomic FOR UPDATE run charges, `shared-budget-charge.test.ts`; disclosed at `VirtualKeysPage.tsx:271`, `OrganizationPage.tsx:511`; ENTERPRISE_READINESS_PLAN.md:266 (N4) | No decision between documented threshold and hard reservation (hold ledger); permitted overshoot undefined per cap (project, run/node, virtual key); no concurrent near-boundary test of preDispatchProjectGate | owner |
| F04 | prio: first batch | Secret persistence outside audit_log | CLOSED | ADR-0102 `prose-scrub.ts` + `prose-scrub.test.ts` (incl. information_schema guard `:558`); ADR-0111 `f04-trace-payload-scrub.test.ts` (traces/OTLP fixed; exports, backups, anchors clean); ADR-0112 `adr0112-conversation-presentation-scrub.test.ts`; ADR-0115 `adr0115-eval-result-scrub.test.ts`; `audit-scrub.test.ts:265-301` chain over redacted rows. Declared residuals: S6 content columns (owner), app-layer/shape-based only, zod-enum/409 echoes; PENDING.md:703 row stale (doc hygiene) | — | codex-confirm |
| F05 | prio: targeted (governance hardening) | Approval scope and payload binding | CLOSED | ADR-0104 (migration 0106; `approval-binding.test.ts`; `approval-payload-binding.test.ts`: negative control, exactly-once, concurrent spend `:514`); ADR-0105 `consent-context-expiry.test.ts` (AER-004 DONE); ADR-0144 `approvalReview.test.ts` + `mcp-action-review.spec.ts`, demo.yml approval-review job green (37024251659); ADR-0166 749ee75/297d0b9 (AER-039) | — | codex-confirm (close with AER-039/040) |
| F06 | prio: after first fixes | Complete user journeys, recoverable failures | PARTIAL | `global-setup.ts` seeds a scratch DB and boots the gateway; `phase1.spec.ts`/`phase2.spec.ts`; `demo-intake.spec.ts` real seeded-DB journey in CI (demo.yml); DEMO_SCRIPT §0 17/17; `mcp-action-review.spec.ts` | No cost-bounded real-provider journey (2); no browser staged-workflow plan/sign-off/build/checks (5); no restart, provider-loss or expired-credential recovery (7); plan-only no-instance boundary undecided (`plan-only.test.ts:301`); phase1/phase2 ungated | owner (credential + plan-only boundary), then claude |
| F07 | prio: before customer pilot | Installation, upgrades, recovery, configuration | PARTIAL | ADR-0063 `data-key-custody.test.ts`, `data-key-reencrypt.test.ts`; `mode-scoped-egress.test.ts` (ADR-0062); `setup-status.ts`; `infra-backup-verify.test.ts`; ADR-0110 unique-constraint preflight in CI; D01/D02 fixes 09-26; demo:prepare 17/17 from an empty DB | No upgrade-from-prior-version proof; no restore drill (encrypted data + audit evidence) since ADR-0035; release keyring dev-only, nobody can sign (`infra/release-keys/README.md:22-34`); no air-gapped egress validation on a real deployment; DEPLOYMENT_READINESS_CHECKLIST parked by owner | owner |
| F08 | prio: alongside fixes | Documentation and capability claims | CLOSED | 2026-10-03: boot banner prints /ui; F04 row, Actions-exhausted and capability claims corrected with dated notes (dbf7bda); ROADMAP CI rows struck (9b5ced5); ADR-0110 note added · earlier: STATE.md last_updated 2026-10-02; PENDING.md:774-777 struck S3-sink/copilot rows; DEMO_SCRIPT 'What is mock vs. live'; `guardrails.ts:10-16` heuristic; `RegulAItLlmPage.tsx:10`; 1b9d6cb cleared the 002/004/005 texts | — | codex-confirm |
| HANDOFF | — | Per-finding handoff (repro, decision, files, limits) | CLOSED | 2026-10-03: dated addendum to PENDING's F01–F08 table with current status and evidence per finding (00ad93c, 9e78e60) · earlier: Per-ADR records (0103–0108, 0111, 0112, 0115, 0144, 0166) carry reproduction, commands and limits; PENDING.md:695-706 F table pinned to HEAD 2c90396 (09-07) | — | codex-confirm |

Totals (58 rows, recounted 2026-10-03 after AER-049 closed on `wt-g2-int`): CLOSED 47 · PARTIAL 8 (AER-028, 029, 036, 046 + F01, F03, F06, F07) · OPEN 2 (AER-014, 016) · WITHDRAWN 1 (AER-025). AER-044, 045 and 047 are independently confirmed RESOLVED/DONE at `dbbb642`; AER-048 and AER-049 are CLOSED for Codex to confirm; AER-029 and 046 stay PARTIAL until Codex confirms the CI run `37125215948` execution of their browser acceptance tests.

## Open work, grouped

**Claude backlog**
- AER-029, AER-046, AER-048 and AER-049: done 2026-10-03 (see Codex to confirm). AER-048's round-2 nits are listed in its row.
- F01: finish the dispatcher's repeated-clean-run evidence and return it for Codex confirmation.

**Owner decisions**
- AER-006: build the org-settings international-PII category UI, or rescope the claim to API-only.
- AER-014: fund the replay-clock fix, or downgrade ADR-0120's 'exactly' claim to an approximation now.
- AER-016: quick mitigation (lower non-admin cap, per-caller concurrency 1) vs job-model redesign.
- AER-028: Kong forwards scrubbed, size-limited args, or Kong is formally narrowed to context-free authorization (then publish the parity matrix).
- AER-036: build OIDC/SAML origin derivation for Kong, or keep the asserted field and narrow the claim.
- F03: documented threshold vs hard reservation; permitted overshoot per cap.
- F06: capped real-provider credential; plan-only boundary for calls naming no workflow instance.
- F07: un-park the pilot ops gate; release-key ceremony; a separate box for upgrade and restore drills.

**Codex to confirm**
- F02 is confirmed RESOLVED/DONE at remote commit `aa233bd`; no further closure action is required. Still to confirm from the 2026-10-03 implementation set: AER-020 (`e09e4cb`), AER-024 (`5a7244c`), AER-012 (`6e3daec`), AER-013 (`40990d6`).
- AER-044, AER-045 and AER-047 are confirmed RESOLVED/DONE at `dbbb642`. AER-029 and AER-046 remain partial pending executable browser evidence; AER-048 is the new workflow-round concurrency finding.
- Added 2026-10-03 after `dbbb642`: AER-048 CLOSED (merged at `7a40d77`); AER-029 and AER-046 browser acceptance tests executed green by CI run `37125215948` at `40f7f2c` ("Mocked UI suite" step).
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

### Automated enterprise-readiness run — 2026-10-03 02:01:58 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`. Review used the isolated aligned worktree
  `RegulAIt-governance-info`; local and `origin/dhruv/active` both resolved to
  `9a13e2653764dbf579485fd7ac48f1e975b15eb2` before review. The ordinary local
  `dhruv/active` checkout remains intentionally untouched because it is diverged.
- Incremental range: `742215252d18bdde15c19ce918b3ac7e537c7db2..9a13e26`, plus
  prior high-risk findings that were not yet present in the remote ledger. Required suite and
  repository instructions were read. No product code, ADR, STATE, PathForward or sibling repository
  was edited.

**Exact checks and outcomes**

- `git status --short --branch`, `git rev-parse HEAD`, and
  `git rev-parse origin/dhruv/active` — clean review branch; SHAs matched.
- `git diff --name-only 7422152..HEAD -- <finding paths>` plus targeted `rg` and numbered source
  reads — deploy-gate, trace-evaluation and workflow auto-pass sources were unchanged; the intake
  checkpoint path changed only for field-help presentation, not retry identity.
- Exact-head GitHub Actions CI run `37094018095` — PASS at `9a13e26`: build-and-test passed,
  gateway 239 files / 3,290 tests, `connector-project-budget.test.ts` 6/6, web
  `kit.test.tsx` 9/9. Demo-journey run `37094018103` also passed. The CI docker-build job was green
  while its actual Docker build step was skipped, so no Docker-build pass is claimed.
- The governance field-help change was additionally verified before publication with TypeScript,
  build (196 web modules), component tests 9/9 and isolated Chromium Playwright 1/1. No database,
  cloud, live-provider, deployment, migration, backup or restore test was run in this review.

**Finding lifecycle**

- **F02 — RESOLVED/DONE.** Remote fix `aa233bd` places the connector project gate before credentials,
  PII, egress and provider execution. Direct source inspection plus the exact-head 6/6 contract suite
  proves exhausted budgets return 409 with zero upstream work and usage while the documented allowed
  cases run and bill. Residual first-crossing semantics remain disclosed under F03.
- **AER-029 — PARTIALLY RESOLVED.** Commit `4474431` adds accessible disclosure buttons and field
  descriptions across governance free-text fields. The representative keyboard/browser and component
  checks pass, but the acceptance criterion still requires an axe scan and full field/stage/theme
  matrix; it is not marked done.
- **AER-044 — HIGH / OPEN.** Explicit `agentIds: []` remains distinct from omission, allowing the
  evaluator to inspect zero agents rather than the use case's intended agents. Acceptance: empty and
  omitted selections must both enforce intended-agent halt/MRM refusal, unless a documented policy
  explicitly rejects empty input; a non-empty subset needs its own policy-bound positive case.
- **AER-045 — MEDIUM / OPEN.** The trace cursor remains based on `startedAt` with a finite overlap.
  A late-completing span older than the overlap can remain unevaluated. Acceptance: durable
  completion/evaluation cursor or queue, with an exactly-once late-completion regression.
- **AER-046 — MEDIUM / OPEN.** Intake retries retain persisted use-case/questionnaire checkpoints
  after editable inputs change. Acceptance: bind checkpoints to a canonical input digest or invalidate
  dependent artifacts; prove retry produces a coherent all-old or all-new transaction.
- **AER-047 — HIGH / OPEN.** `workflows.ts:714-756` converts absence of both eval outcome and report
  into a passed automated check. This is failure-honesty risk: a missing control result can authorize
  progression. Acceptance: explicit pass advances, explicit fail blocks, missing/timeout remains
  pending or blocks with an audit row, and production configuration cannot enable auto-pass.

**Remaining uncertainty and owner action**

- AER-012, 013, 020 and 024 carry substantial implementation evidence in the ledger but were not
  independently closed in this targeted run. Their status remains pending Codex confirmation.
- Suite finding P23 remains an owner action: `LICENSE`, `LICENSE.md` and `SECURITY.md` are absent at
  `9a13e26`; repository security-feature enablement is outside this automation's authorized writes.
- No enterprise-readiness, production-readiness, certification or complete provider/deployment parity
  conclusion is justified by this targeted review.

### Implementer update - 2026-10-03 (Claude: AER-003, 006, 009, 010, 011, 015, 018, 026, 029, 030, 033, 034, 035, 037; F01, F08, HANDOFF)

Integrated on `dhruv/active` (commits listed in each ledger row). Each group was implemented in its own
worktree with a negative control per test, reviewed adversarially, fixed, and re-reviewed to "ship";
then the full gate ran on the integrated tree (fresh-database suite, build, demo verification).

- **Closed, for Codex to confirm:** AER-003, 006, 009, 010, 011, 015, 018, 029, 035, 037, F08, HANDOFF.
- **Verified by their first green Integrations run (run 37110038871 at `8c0132b`, 47/47), now CLOSED for Codex to confirm:** AER-026, 030, 033, 034. The
  first review caught a config Kong would refuse at load (two consumers sharing one custom_id); fixed in
  2312d48. The plugin now refuses only its own five protocol header names — the earlier draft refused the
  whole `x-regulait-*` prefix, which would have blocked the `x-regulait-project-id` IDE_INTEGRATION.md
  tells clients to send. ADR-0127 amended.
- **F01:** S8 diagnosed and fixed; phase1/phase2 gated in CI; repeated clean runs are recorded with the
  gate results.
- **New gaps found while fixing (recorded in PENDING):** outlook ChatOps cannot post outbound (501);
  compat cache commits cacheSystem while native does not (owner question); at the cert_rotate decision
  site a kill-switch refusal is audited as a provider failure.
- **Codex's 2026-10-03 run:** AER-044, 045, 046 and 047 are now closed (next bullet); AER-047 implemented
  the recorded L1 recommendation (a missing report stays pending with an audit row by default; a template
  must opt in to labelled offline auto-pass, honoured only where `REGULAIT_OFFLINE_CHECKS=1` is declared;
  the demo's seeded templates opt in). P23 (LICENSE, SECURITY.md) is an owner action.
- **Closed, for Codex to confirm (integrated 2026-10-03, ledger rows carry commits, tests, negative
  controls and honest limits):** AER-044 (`ec68ebc`, `4f7516b`: a deploy-gate `agentIds` selection never
  narrows the approved stack), AER-045 (`d6571ff`, `e814d31`, `e458a3e`: durable anti-join queue above a
  fixed floor), AER-046 (`d3409d8`, `d38d3e4`, `89061ee`: retry checkpoints bound to their inputs; start
  over withdraws the earlier record) and AER-047 (`f734abd`, `6477266`, `2542ae2`, `6079d47`, `d9b01fc`,
  `e137fdf`: an unreported check stays pending; the labelled offline opt-in fails closed).
- **Later 2026-10-03 (after `dbbb642`):** AER-048 is CLOSED for Codex to confirm (`a0f0d85`, `be1f3d9`,
  `f54f0a0`, `26bfb09`, merged at `7a40d77`: reports and executor completion bind to a durable round /
  stage-entry token, fail closed for CI; `workflow-check-round` 10/10 with a negative control per fix; two
  adversarial reviews, the second "ship"). The review opened AER-049 (effect records survive a re-open past
  merge/deploy, so a v2 round can complete as shipped on v1's merge/deploy) as an owner decision. AER-029 and
  AER-046: CI run `37125215948` at `40f7f2c` executed `intake-a11y.mock.spec.ts` and
  `intake-retry.mock.spec.ts` green in the new "Mocked UI suite" step (`6da2627`); still PARTIAL until Codex
  confirms.
- **Later 2026-10-03 (integration branch `wt-g2-int`):** AER-049 is CLOSED for Codex to confirm. The owner
  chose per-round effect records and a configurable number of reviews: a change after merge or deploy runs a
  new review round and ships again on a fresh `-r<round>` branch and a NEW PR; earlier rounds' records go to
  `effects:history`; the kernel `reopen` targets only a review at or before the first PR / merge / deploy
  stage (`385631d`, `604158b`, `69bb1ad`, `f0adbd2`, `a1b679e`; `workflow-check-round` 17, kernel 50/50,
  gateway 3401; two adversarial reviews, both should-fixes fixed). Full gate on <sha>: see commit message.

### Automated enterprise-readiness run — 2026-10-03 07:02:03 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`. The prior isolated worktree directory had been removed while its
  Git metadata remained. The missing path was verified, stale worktree metadata was pruned, and a new
  isolated worktree was created from `codex/governance-field-help`; the dirty `main` checkout and its
  untracked content were not touched.
- `git pull --ff-only origin dhruv/active` advanced the review checkout from
  `1b7ebba75e976d3bee82aa488aa7dd41413598d5` to
  `dbbb64210d36629211e895115dc400b74fff79e3`; local and upstream SHAs agreed.
- Reviewed range: `1b7ebba..dbbb642`, with direct review of AER-029 and AER-044..047 plus the newly
  disclosed workflow concurrency boundary. Required suite/repository instructions were read first.
  No product code, ADR, STATE, PathForward or sibling repository was edited.

**Exact checks and outcomes**

- Read-only GitHub Actions inspection (`gh run list` / `gh run view --log`) found all exact-head runs
  green: CI `37120058343`, Demo journey `37120058322`, Integrations `37120058356`.
- CI build-and-test passed gateway 243 files / 3,357 tests, shared 54 / 1,266, web 12 / 95 and workflow
  kernel 1 / 45. Targeted passes included deploy-gate 14/14, AER-044 route 10/10, trace evaluation 7/7,
  intake route contract 2/2, intake checkpoint 9/9, workflow checks 13/13 and eval harness 23/23.
  Docker build executed and passed. The gated SPA job executed only phase1/phase2 (39/39).
- The exact-head logs contain no execution of `intake-a11y.mock.spec.ts` or
  `intake-retry.mock.spec.ts`; merely packaging those files into Docker is not test execution. This is
  a verification-gap result, not a claim that their assertions fail.
- Targeted numbered source inspection covered `deploy-gate.ts`, `trace-evaluation.ts`,
  `intakeCheckpoint.ts` and `workflows.ts`. No local database, browser, cloud, provider, deployment,
  migration, backup or restore test was run.

**Lifecycle decisions**

- **AER-044 — RESOLVED/DONE.** Direct source plus exact-head 14/14 and 10/10 tests prove an explicit
  empty/subset selection cannot narrow the intended-agent stack.
- **AER-045 — RESOLVED/DONE.** Direct source plus exact-head 7/7 proves the moving-overlap miss is
  removed and normal late completion is exactly-once. The fixed pre-cutover floor and scan cost remain
  disclosed limitations.
- **AER-047 — RESOLVED/DONE.** Missing reports now wait by default; the explicit demo-only opt-in is
  typed, environment-bound, labelled and audited. Exact-head workflow/eval/kernel tests cover the
  original acceptance criteria.
- **AER-029 — PARTIALLY RESOLVED.** The implementation and dedicated axe journey exist, but that
  journey is absent from all exact-head CI commands inspected. Closure awaits a fresh executable run
  or a durable gate.
- **AER-046 — PARTIALLY RESOLVED.** Planner and real-route contract tests pass, but the only browser
  test exercising fail/back/edit/retry and start-over is not executed by the exact-head gates.
- **AER-048 — HIGH / OPEN (new).** The executor snapshots context under a short claim transaction,
  performs potentially long eval work, then writes the entire stale context without locking or
  comparing a stage-entry token. A concurrent report or re-open can commit under lock and then be
  overwritten by that stale executor. This is direct source observation; the race has not yet been
  reproduced. The ledger row gives the token/CAS remediation and four barrier acceptance tests.

**Remaining uncertainty**

- AER-012, 013, 020 and 024 were not independently closed in this targeted run. AER-014 and AER-016
  remain open owner decisions. P23 (licence/security policy and repository security features) remains
  an owner action.
- No enterprise-readiness, production-readiness, certification or complete parity conclusion is
  justified by this targeted review.

<!-- codex-enterprise-feedback:end -->
