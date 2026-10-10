# Codex feedback — active work and verified closures

Updated: 2026-10-04 15:40 CDT (UTC-05:00). Review target: `dhruv/active`.
Latest scoped source/test snapshot: `ff7fdbcc635663afd0c855f61eb9a742f472259a` (local = upstream before feedback publication).
Prior intake acceptance baseline remains `b5e1da5524a3705d1a69094f13cf10db60311298`; the October 4 snapshot is NOT a full review of every intervening product change.


## X18 live foundation check — 2026-10-07

Built the actual foundation gateway and ran the Batch 3 browser journey against a fresh isolated database with this branch’s SPA explicitly selected. **5/5 PASS**, including exact live metrics block `{separateListener:"off",mainListener:false,tokenConfigured:false}`, matching three visible configuration statements, retention audit, MCP grants, stdio refusal, Outlook recipients and ownership. This is no-stdio-opt-in coverage; earlier opt-in evidence remains historical. First run served the default checkout’s SPA because the gateway-dist symlink resolves its default path there; that failed retention-page lookup is excluded, and the final run sets `REGULAIT_WEB_DIST` explicitly. Local evidence, not committed: `gemini-review/r18-foundation-live-final{.log,-results}`.

## X18 integration and R18-11/12 — 2026-10-07

Merged main ca3e36a1 after Claude integrated X13, moved retention into the shared RouterProvider route list, and retained main's review-policy fixture wording. The initial merge-script failure captured conflict markers in773eafa7; immediately corrected atf362e2fe without rewriting pushed history, and all subsequent checks run on the corrected tree. Added mainListener:true with and without a configured token; registration and update now link the inline no-secrets warning to fieldsets and argument inputs using unique aria-describedby IDs. Mocked metrics/stdio checks **12/12 PASS**, web units **339/339 PASS**, production build/typecheck PASS. The real foundation metricsPosture() matches the three-field contract; live listener verification follows the fresh build. Logs: `/workspace/.regulait-onboarding/gemini-review/r18-integrated-{browser.log,results,units.log,build.log}` (local evidence, not committed).

## X18 R18-01/02 review fixes — 2026-10-07 UTC

The metrics card now reads the authenticated, token-free GET /v1/org/posture metrics block agreed in AgentCoordination §4.9. It reports separate-listener off/loopback/non-loopback, main-listener state and token configuration as deployment configuration, without claiming proxy reachability. The browser /metrics request is removed, so an unrelated reverse-proxy HTML 200 cannot raise an unauthenticated-metrics alert. Missing/malformed fields remain unmeasured rather than defaulting to disabled; request failures explain that refusal/missing route does not prove metrics-off. The same stdio argument component used by registration and update now warns inline that arguments are audited and visible to admins and must never contain secrets.

Mocked browser **9/9 PASS**: three complete 200 configurations; 401 route refusal, 404 and 500 with retry recovery; missing block; authoritative enabled-without-token warning; session-loss 401 to sign-in. Every fixture counts zero browser /metrics requests, including a synthetic proxy HTML-200 trap. Web units **331/331 PASS** and production build/typecheck PASS. Evidence: `/workspace/.regulait-onboarding/gemini-review/r18-{metrics.log,metrics-results,units.log,build.log}`. Existing real Batch-3 evidence remains historical; the new metrics block is mocked until Claude announces the foundation. Current main lacks it and therefore stays unmeasured. Per Claude's explicit integration order, final main merge and moving retention into X13's RouterProvider route list wait for X13 to land; no fabricated live verification.


## X18 — CI follow-up (2026-10-07)

CI on f650cc1b reported `spa-mock / shard 3` UXJ-01 MCP list failure (82 other cases passed) and the review-policy sign-in failure at `totp-sign-in.ts:123`. The new MCP coverage/ownership components dereferenced absent settings/users in the existing synthetic error fixture, preventing the existing Table error/Retry UI from rendering. Guard missing projections, retain an explicit unreported-coverage notice, and preserve the unchanged error/Retry assertions. The fresh review-policy persona reaches the authenticated AI-policy acknowledgement interstitial before Home; accept that as a sign-in terminal while retaining the journey's explicit acknowledgements and enforced gate (same helper correction validated on X13).

Follow-up validation: `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-mock.config.ts ui-defects.mock.spec.ts --grep UXJ-01 --trace=on --output=/workspace/.regulait-onboarding/x18-error-regression` **5/5 PASS**. Positive stdio fixture: `E2E_DB=regulait_x18_followup E2E_PORT=3112 E2E_BASE_URL=http://127.0.0.1:3112 E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium E2E_MCP_STDIO_COMMAND=/workspace/.regulait-onboarding/mcp-bin/ui-fixture REGULAIT_MCP_STDIO_ALLOWED_DIRS=/workspace/.regulait-onboarding/mcp-bin REGULAIT_PUBLIC_URL=https://regulait.example.test pnpm --filter @regulait/web exec playwright test batch3.spec.ts --trace=on --output=/workspace/.regulait-onboarding/x18-followup-real` **5/5 PASS**, including cleanup. Original no-opt-in 5/5 evidence above remains unchanged. Web units **331/331**, `pnpm --filter @regulait/web exec tsc --noEmit` and web build PASS (`x18-followup-{units,typecheck,build}.log`).

Fresh isolated demo: main's compiled gateway, this branch's built SPA, database `regulait_x18_demo_review2` on loopback3111; `pnpm --filter @regulait/gateway demo:prepare` **19 PASS / 0 WARN / 0 FAIL**, then `E2E_BASE_URL=http://127.0.0.1:3111 E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-real.config.ts --trace=on --output=/workspace/.regulait-onboarding/x18-demo-isolated` **2/2 PASS** (`x18-demo-prepare2.log`, `x18-demo-isolated.log`, traces). Earlier reused-database run (1 failed/1 passed) and simultaneous global-setup run (1 failed/1 passed) are excluded: the latter loaded a shared `.e2e-state.json` pointing the API helper at3112 while its browser used3111. Sequential fresh preparation with no shared state removed that setup conflict; neither failed attempt is counted as a passing demo. Credentials remain synthetic; no chat messages or MCP commands were sent/executed.

New CI is pending after this push. Coordination lint independently remains blocked by inherited old Claude messages (M2 prohibits deleting them); the separate metrics listener remains explicitly unmeasured pending Claude's contract. No backend, workflow or board edits on this task branch.

## X18 Batch 3 web delivery — 2026-10-07 UTC

Built against live §4.8 on main `f5bb4736`: Memory & retention settings/navigation and counts-only inventory; MCP method/transport coverage and separate per-user protocol grants; stdio registration/update with separate argv strings, pinned digest and admission state; connector/MCP ownership; Outlook recipient allow-lists. Expiry, evidence-hold, owner and transport refusals now explain what happened while preserving payload codes. Browser vocabularies are pinned against shared's contract by a drift test.

Every relaxation explains its audit. Increased retention, enabled protocol/transport coverage and added recipients require confirmation. Read-only server grants explicitly include no protocol methods; logging is labelled write. Owners must be active users or explicitly unassigned; orphaned integrations stay visible. Stdio sends no HTTP-only URL/private-range keys; command updates explain admission reset. Outlook uses one exact mailbox per line, 50 maximum; invalid values are refused without replacing the saved list.

Metrics scope: a bounded 5-second, token-free main-listener probe reports 401/404/200/unknown without loading/displaying metrics content. Separate-listener configuration stays **unmeasured**, since §4.8 contains no admin metrics posture API; the contract question is in #149. Main-listener 404 never implies deployment-wide metrics-off. Stores with `enforcedBy: null` say **No retention sweep implemented**; absent timestamps say no successful run is recorded.

Validation: typecheck/production build PASS; **331/331 web units**. `e2e/batch3.spec.ts`, standard `playwright.config.ts`, real gateway with a fresh isolated seeded database and actual UI authentication/TOTP/required policy acknowledgement: **5/5 PASS with operator stdio opt-in**, **5/5 PASS without host opt-in**. Checks actual audit transitions, persisted protocol entitlements, separate argv with embedded spaces, command digest/admission reset, both owner endpoints, orphaned owner clearing, and Outlook save/400 refusal. Retention confirmation uses keyboard trap/Escape/focus return; retention page axe passes light/dark. No actual screen-reader session claimed.

Commands: `E2E_DB=regulait_x18_browser E2E_PORT=3108 E2E_BASE_URL=http://127.0.0.1:3108 E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test e2e/batch3.spec.ts`, with an operator-allowed local fixture via `E2E_MCP_STDIO_COMMAND`/`REGULAIT_MCP_STDIO_ALLOWED_DIRS`. The second run uses `regulait_x18_no_stdio`, port3109, no stdio opt-in. Both use synthetic `REGULAIT_PUBLIC_URL=https://regulait.example.test`. Evidence under `/workspace/.regulait-onboarding/`: `x18-real-final{,.log}`, `x18-no-stdio{,.log}`, `x18-final-build.log`, `x18-units2.log`. The executable is never invoked, Outlook credentials are registration-only and **no messages are sent**. Settings restored, user fixtures deactivated; integration rows remain in disposable scratch databases.

Earlier failed runs are retained: implicit browser context for axe, the strict stdio schema rejecting an HTTP-only field, a registry link incorrectly located as a row, and cleanup's duplicate deactivation/empty JSON body. Final counts include successful cleanup. No gateway/shared/database/scripts/workflow changes. Claude review, CI and metrics contract answer pending.
## R13-13 resubmission state preservation — 2026-10-07

SessionProvider.refresh clears the query cache on owner change; the next router render used to unmount the record-dependent form and silently replace unsaved edits with the stored use-case description. Preserve the editing session's local record baseline across cache loading/error states, keep owner-bound draft and submit checks, and pause submission while current record access is unavailable. The form remains mounted; only explicit discard/navigation ends its state.

Genuine baseline red: latest unsaved purpose disappears after real SessionProvider.refresh plus router POP. Final focused browser **8/8 PASS**, including successful and403 record reloads, owner-change refusal, owner-named draft deletes, failed-save retry/discard and busy exits. Web units **336/336 PASS**, production build/typecheck PASS. No PATCH, artifact POST or draft DELETE is sent under the changed owner; earlier saved draft is retained. Local evidence, not committed: `/workspace/.regulait-onboarding/gemini-review/r13-state-{red.log,red-results,final.log,final-results,units.log,final-build.log}`.

## X13 R13-01 review fix — 2026-10-07 UTC

A fully saved registration could not leave after SessionProvider.refresh changed the signed-in owner in place: flush refused the actor change, while Discard was hidden because nothing was unsaved. Both registration and resubmission now use a navigation-only decision that permits owner-changed solely when the page has no unsaved work. The hook still checks the owner before comparing saved content, sends no PUT/DELETE for the changed owner, and durableForSubmit still refuses owner-changed; pending/failed saves remain blocked and explicit discard remains available for unsaved work.

The regression invokes the real SessionProvider.refresh via a documented React development-fiber fixture, without patching save results or state. Against unchanged product code, registration genuinely fails at leaving the intake URL (`gemini-review/r13-red-results` and `r13-baseline-results`). Early resubmission fixture failures assumed a stable mounted form/dialog despite query-cache clearing and are excluded as red proofs; that exploratory test was removed. Final focused registration/failed-save/resubmission-retry/discard suite **4/4 PASS**, web units **330/330 PASS**, and web production build/typecheck PASS. Logs and traces: `/workspace/.regulait-onboarding/gemini-review/r13-{final.log,final-results,units.log,build.log}`. Existing prior broad intake evidence remains historical; the new owner-change regression is additional.


Current main6fb9befd merged without rebase at05bdfcf5, retaining X20's controls and both ledger sections. Post-merge verification: focused browser **4/4**, units **330/330**, production build/typecheck PASS (`gemini-review/r13-main-{browser.log,results,units.log,build.log}`).

## X13 Forward CI follow-up — 2026-10-07 UTC

CI run [37611645993](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37611645993), shard-2 job112760035386 at `8519ffe5`, failed the browser Back/Stay/Leave/Forward case after calling Forward: expected intake, remained on registry. **Reproduced locally: 1 failed, 14 passed in 15 identical repetitions.** Not labelled a flake. The failing local trace proves POP changed the address to `/ui/admin/use-cases` before React committed the registry: snapshot `before@call@764` (51485.489ms) still contains the intake's “Leave this registration?” dialog, and `before@call@768` (51505.952ms) still references that same rendered page when Forward is called. The registry finishes rendering in `after@call@768`, after the premature Forward.

The test now waits for the actual **AI registry** heading and disappearance of the intake dialog before Forward, retaining its draft-save and exact recovered-title assertions. No extra sleep or product history entries. **15/15 identical repetitions PASS** with that observable destination wait. The prior scoped 45/45 mocks, 328/328 web units, builds and real journeys remain the product-change baseline; this follow-up changes test synchronisation only.

Evidence: `/workspace/.regulait-onboarding/x13-forward-repeat-correct{,.log}` (red repeat9 trace), `x13-forward-final{,.log}` (15 green traces). Local follow-up worktree uses existing dependencies/compiled TOTP; symlinks are excluded from git. Intermediate attempts with wrong working directory, occupied Vite port and missing compiled TOTP are excluded. CI artifact access still proxy403, but check-run annotations and the independent local reproduction agree on the failing assertion. New CI pending after push.

## X13 B1/M1 review rework — 2026-10-07 UTC

**B1 fixed:** Edited registrations and resubmissions offer an explicit **Discard and leave** when the latest draft cannot be kept, including oversized and unresolved initial reads. This stops queued/debounced/unmount saves synchronously, leaves without submitting, and preserves an earlier server draft. The ordinary Leave action still waits for a successful save; Stay retains the latest edit. In-flight submission/save disables discarding until the bounded save finishes. The dialog explains exactly which changes are given up.

**M1 covered:** `M1: Back after direct URL entry warns and sends the latest exit snapshot` enters by document URL, dismisses the native beforeunload warning and checks the edit survives, then accepts Back and observes the actual actor-bound keepalive fetch invocation with the latest edit. The fetch observer forwards the original request unchanged. Playwright page interception cannot establish delivery after that document unloads; this test proves the native warning and exit request invocation, while the existing pagehide test checks mocked persistence. Browser delivery and server enforcement remain separate evidence.

Validation: web typecheck and production build PASS; web units **328/328**; `pnpm -r build` PASS. System Chromium, `playwright.demo-mock.config.ts`, intake drafts/a11y plus selected resubmission tests: **45/45 PASS**, including light/dark axe and all four new B1/M1 cases. Exact selection: `--grep 'B1:|M1:|AER-|ADR-0179|failed questionnaire post|edits are kept as a draft|refused resubmission exit|Cancel and Back wait'`. Three B1 cases fail against the prior source (missing discard action), then pass with this fix. Logs/traces/screenshots: `/workspace/.regulait-onboarding/x13-b1-red{,.log}`, `x13-review-full{,.log}`, `x13-b1-{tsc,build,units}.log`, `latest-workspace-build.log`. Main `f5bb4736` and remote `codex/x13` merged without rebase.

Fresh real-gateway verification reproduced the review-policy CI failure: the isolated new admin fixture correctly reaches the mandatory AI-policy acknowledgement interstitial, but its sign-in helper waited only for Home before the acknowledgement code could run. The helper now accepts that authenticated interstitial as the completed sign-in destination, retaining the journey's explicit acknowledgements and strict gate. The failed real run is retained at `x13-real-journeys{,.log}` outside the checkout; this is distinct from the fixed X17 draft isolation problem.

Fresh isolated database preparation: **19 pass, 0 warn, 0 fail**. Both real demo journeys **2/2 PASS** after the helper correction (`playwright.demo-real.config.ts`), including required AI-policy acknowledgement, high-tier proposal, two reviews, send-back, resubmission and approval. Evidence: `/workspace/.regulait-onboarding/x13-real-prepare2.log`, `x13-real-journeys3{,.log}`. An intermediate rerun used a surviving old gateway and is excluded from these counts.

Review and CI remain pending; Claude owns DONE/VERIFIED. Board changes are isolated in PR #149. M2 preserves Claude's messages; inherited older-than-12h messages currently block board lint, and the primary ISO text remains inaccessible (proxy tunnel 403), so no clause confirmation is claimed.

## X13 recovery recheck — 2026-10-06 UTC (review pending)

AER-050's listed frontend recovery acceptance paths pass against the mock gateway. Existing ADR-0179 already makes attempt keys durable before create and keys artifact/risk retries; this change closes the remaining programmatic navigation and refused/stalled draft-save exits. React Router's existing data router/useBlocker covers links and same-app history. Leave stays on the form if flush fails; a 15-second save timeout releases the queue without sending an untracked create. Completed resubmissions navigate only after their guard renders inactive.

Validation: `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-mock.config.ts e2e/intake-drafts.mock.spec.ts e2e/intake-a11y.mock.spec.ts` — 37 passed; selected `e2e/zz-review-round.mock.spec.ts --grep 'X13:|ADR-0171:|keyboard: Continue'` — 4 passed. Includes exact draft recovery after reload/Back/Forward, authentication expiry and another-user isolation, committed create/artifact/risk lost responses, and failed resubmission exit saves. Axe passes light/dark on intake and the failed-save dialogs. Web typecheck, production build and unit tests are recorded in the task Evidence line.

Red proofs: palette and refused exit-save cases fail with the old guard/callbacks; stalled checkpoint fails without the timeout; refused resubmission exit save fails with the old guard. Logs: `/workspace/.regulait-onboarding/x13-red-browser.log`, `x13-timeout-red.log`, `x13-resubmit-red.log`. Screenshots: `x13-final-browser/**/x13-failed-exit-save.png` and `x13-resubmit-final/**/x13-resubmission-exit-save.png` beneath the same evidence directory. Retained traces accompany failed red runs.

Scope: browser tests use synthetic mocked gateway responses. They establish frontend recovery behavior, not a new independent certification of server idempotency or external integrations. Claude must review the change before marking the task VERIFIED. The older AER-050 observations below describe the earlier code and are superseded within this tested frontend scope.

### X13 main integration — 2026-10-07

Main `2ba28faf` merged at `f05bfea3` without rebase; task branch board now matches main and status lives in #142 (`codex/board`). Fresh validation: web units **326/326**, `pnpm --filter @regulait/web exec tsc --noEmit`, and `pnpm --filter @regulait/web build` PASS. System Chromium mock `intake-drafts.mock.spec.ts` + `intake-a11y.mock.spec.ts` **37/37 PASS**, including both axe themes; selected `zz-review-round.mock.spec.ts` resubmission cases **4/4 PASS** with `--grep 'failed questionnaire post|edits are kept as a draft|refused resubmission exit|Cancel and Back wait'`. Both use `--config playwright.demo-mock.config.ts --trace on`; exact command prefix `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test`. Logs/traces: `/workspace/.regulait-onboarding/x13-main-browser{,.log}`, `x13-main-resubmit{,.log}`, plus `x13-main-units.log` and `x13-main-build.log`. Main's refusal-guidance API changes were retained alongside X13's request cancellation support. This resolves the merge/CI-start blocker; review and new CI completion remain pending.


## X20 — Identity and policy keyboard audit (2026-10-07)

READY-FOR-REVIEW on `codex/x20`; frontend only. `identity-policy-keyboard.mock.spec.ts` exercises users, roles, teams, client access, SSO, rules engine, simulation and approvals queue using the X14 real-Tab/Enter/Arrow/typing harness. Fixture installation and page entry are preconditions; no `.click()`, `.focus()`, `.fill()` or `.selectOption()` performs an audited interaction.

Four corrected baseline cases fail against main and four controls pass (`x20-red-corrected.log`): nested role Delete also selects its row, generated client configuration has no success announcement, a rule submission loses focus when its button is temporarily disabled, and access evaluation has no result announcement. Fixes guard row Enter against descendant events; announce configuration generation/copy through the existing polite toast region; keep rule/evaluation buttons focusable with `aria-disabled` and guarded submissions; provide a persistent atomic access-preview status and clear the previous decision when re-evaluating. A failed subsequent evaluation cannot announce the earlier result as current.

Final validation: `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-mock.config.ts identity-policy-keyboard.mock.spec.ts sso-admin.mock.spec.ts policy-simulation-incomplete.mock.spec.ts --trace=on --output=/workspace/.regulait-onboarding/x20-final` — **12 total cases PASS: 8 new keyboard page audits and 4 existing regression cases**, **32 full-page axe analyses PASS**, WCAG 2 A/AA, 2.1 A/AA and 2.2 AA in light/dark. Includes modal Tab/Shift-Tab traps, Escape/return focus, required reason and server-refusal live errors, native multi-selection, recorded override/MFA reasons, synthetic clipboard success/refusal, and held-request repeated-Enter checks proving one evaluation/rule request. `pnpm --filter @regulait/web test` **328/328 PASS**; `pnpm --filter @regulait/web exec tsc --noEmit` and `pnpm --filter @regulait/web build` PASS. Logs/traces are under `/workspace/.regulait-onboarding/x20-{final,final.log,red-corrected,red-corrected.log,units.log,typecheck.log,build.log}`.

Limits: synthetic API fixtures verify browser semantics and request shapes, not backend authorization. No actual screen-reader session was available; live-region/accessible-name checks and axe do not establish complete assistive-technology compatibility. Cancellation restores modal triggers; successful deletion of a removed trigger is outside this audit. Coordination lint still fails on inherited Claude messages older than 12h; M2 expressly prohibits deleting them. Claude alone reviews/merges and marks VERIFIED.

## X16 key-custody CI investigation — 2026-10-07 UTC

Original CI run [37543718055](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37543718055), job
112542824893, at `2e2c29db1d54340657058093314c4d112fc99375`: 46 passed, one failed at the developer custody
explanation. Artifact access initially returned HTTP 403; the original artifact later downloaded successfully.
Artifact `spa-journeys-failure`, id 11449489421, SHA256
`34b548e64012ba4517104aef3eac0558afe2f6e5724b1fd782eef5f79faa9228` is retained at
`/workspace/.regulait-onboarding/x16-original-artifact.zip`.

**Cause supported by the 2e2c29d trace, not classified as a flake:** the posture PUT returned 200 with
`keyCustodyEnforced: true`. Avery's account key was filled at trace time 42330.091 ms, but the literacy GET
(start 42269.549 ms, duration 93.135 ms) finished around the Save key click (42359.996 ms). Its body was
`required: false, current: true, documents: []`. The subsequent DOM snapshot (`after@call@1401`) contains
**A key is required.** There is **no developer credential POST at all in this 2e2c29d trace**; this is not a claim about every failed run. The missing
custody copy was therefore not a failed backend custody refusal: the form lost its input before submission.
Claude's 2026-10-07 review reports a different ordering on `f676ca3`: a credential POST reached the gateway and returned **409 key_custody_enforced** about 1.4 seconds after Avery's sign-in; the later literacy remount erased the received notice. Both input-before-submit loss and notice-after-response loss share the same remount mechanism. That second CI observation is attributed to Claude's gateway-log review; only the original 2e2c29d artifact was independently inspected here.
Only sanitized status/posture/error information is reproduced here; no credential bodies are published.

`AcknowledgeGate` returned its page in fragment slot 0 before the async literacy response, then in slot 2
beside two optional banner slots afterward. React remounted AccountPage and reset its input state, even
though the Account route is exempt from the interstitial. Keep the page in a keyed Fragment across the
loading/known-posture branches; no new DOM wrapper or gate relaxation. A controlled delayed-response
browser regression fails on the old source with an empty key, then passes with the key retained, one real
mocked 409/key_custody_enforced POST, the correct custody notice and no key left in the DOM. The initial
read of the original trace and the controlled old-source failure distinguish this from a timing guess (M-070).

The journey also awaits and checks its real posture PUT (200/enforced) and credential POST
(409/key_custody_enforced), reporting only status/error. Two clean-source runs at the original revision
hit an earlier strict-console favicon 404 (19 passed / 27 not run / 1 failed each). The included explicit
bundled SVG favicon fixes that separate reproduced issue. It was not the original custody cause.

The delayed-response regression and the existing literacy mock suite passed **6/6**; its old-source control
failed exactly on retained input. Commands:
`E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test --config playwright.demo-mock.config.ts e2e/adr0182-a14-literacy.mock.spec.ts --trace on --output=/workspace/.regulait-onboarding/x16-late-literacy-green`.
Logs/traces: `x16-late-literacy-red`, `x16-late-literacy-green` beneath that setup directory. The earlier
diagnostic-only revision passed the original four real-gateway specs **47/47** (`x16-fixed-browser.log`).
Root-cause fix validation: `pnpm --filter @regulait/web test` **315/315**, web tsc and build PASS.
Real-gateway phase1/phase2/phase6-agent-builder checks **44/44** passed on fresh `regulait_x16_root_cause`
(`x16-root-browser.log`, full traces `x16-root-browser`, screenshots `x16-root-shots`). The fourth original
spec, phase6-builder-tools, passed **3/3** separately on fresh `regulait_x16_root_tools`:
`E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium E2E_DB=regulait_x16_root_tools E2E_PORT=3105 E2E_BASE_URL=http://127.0.0.1:3105 E2E_LOG_DIR=/workspace/.regulait-onboarding/x16-root-tools-logs E2E_SHOT_DIR=/workspace/.regulait-onboarding/x16-root-tools-shots pnpm --filter @regulait/web exec playwright test e2e/phase6-builder-tools.spec.ts --trace on --output=/workspace/.regulait-onboarding/x16-root-tools-browser`.
Root-fix coverage is 44+3 separately, rather than a new single 47-case run. The first 44-case command also named an absent
deep-links.spec.ts; that argument selected no tests and is not claimed as coverage. X14 also touches AcknowledgeGate for focus handling;
merge both the keyed page preservation here and X14's entry/exit focus behavior when reviewing those drafts.

## X17 review-policy fixture isolation — 2026-10-06 UTC (review pending)

The real review-policy spec reused the preceding demo's proposer, so its initial draft GET could see that person's still-pending cleanup. This is separate from X13's navigation/failed-flush guards. Give the spec its own fresh admin identity; arrange the same current AI-policy standing as the seeded personas through the real self-acknowledgement route, without relaxing literacy or MFA. Assert its initial draft is null. Restore the original org policy and deactivate the fixture in teardown, including when policy restoration fails.

Regression evidence: on the real `regulait_x17_demo` scratch database, plant a valid registration draft for the previous seeded admin. Reverting only the proposer login to that shared identity makes the new null-draft assertion fail with the exact earlier title/state (`x17-red-draft.log` and trace). Restoring the fresh identity completes the entire two-review/send-back/resubmit/approval journey: 1/1 passed (`x17-fixed.log`); the preceding admin's draft remains unchanged and every fixture account is deactivated. Initial fixture attempts exposed the fresh account's mandatory literacy gate; that prerequisite is now explicitly arranged, not disabled.

Final integration: prepare a separate empty `regulait_x17_full` database with a local demo export key — `pnpm --filter @regulait/gateway demo:prepare` passes 19/19 readiness checks; `E2E_BASE_URL=http://127.0.0.1:3108 E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-real.config.ts --trace on --output=/workspace/.regulait-onboarding/x17-full-browser` passes both real demo specs (2/2). Web typecheck and production build pass. Screenshot: `x17-full-browser/**/x17-owned-intake-fixture.png`; passing traces are retained there, and the isolated contamination case under `x17-fixed-browser`.

No gateway changes, no test-order retries, and no cleanup of another journey's draft. This closes the spec independence issue; it does not make asynchronous application draft deletion synchronous.

X17 security-gate follow-up (2026-10-07): the original draft's CodeQL job
[112557122023](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37548075701/job/112557122023)
reported unallowlisted `js/insecure-randomness`, severity 7.8, at gateway `totp.ts:62`. The newly introduced
fixture email carried a `Math.random()` identifier into the shared TOTP sign-in helper. Use Node's
`crypto.randomUUID()` for that fixture identifier; no gateway cryptography or scanner allow-list changes.
The precise SARIF path remains unavailable (artifact host productionresultssa15.blob.core.windows.net returns
403); this is a targeted removal of the insecure test source, and closure of the security gate depends on
CI, not a supposition about a false positive.

On the completed X17 web build, the UUID fixture's real two-review/send-back/resubmission/approval scenario
passed **1/1** (`x17-secure-fixture-final.log`, full trace and owned-fixture screenshot under
`/workspace/.regulait-onboarding/x17-secure-fixture-final`). The same isolated database still contains the
preceding administrator's seeded draft. Web tsc and build passed. Command after sourcing `x17-env.sh`:
`E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test --config playwright.demo-real.config.ts e2e/demo-review-policy.spec.ts --trace on --output=/workspace/.regulait-onboarding/x17-secure-fixture-final`.

## X15 — Independent D4 / strict-default review — 2026-10-07

Read-only product-source review of main `5c920dd8` (source baseline `94c0cb87`). Two OPEN findings below belong to Claude's gateway scope; no gateway/db/shared code, defaults, scanners, or existing tests were changed. This is a scoped adversarial review, not a certification of every live provider workflow.

**X15-H01 — OPEN / HIGH — Incident evidence hold races an already-admitted configuration write.**

Evidence: `apps/gateway/src/agents-connectors.ts:2858` checks `agentEvidenceHoldRefused` before calling `applyRuleEdit`; the subsequent transaction acquires the agent row lock. On a fresh real PostgreSQL database, hold that agent row in a second session (`BEGIN; SELECT id FROM agents WHERE id = $1 FOR UPDATE`), start authenticated admin `PATCH /v1/agents/:id` with `{costPerMTokIn:123}`, and confirm its real SQL is waiting for the row lock in `pg_stat_activity`. While it waits, create a serious incident linked to that agent through `POST /v1/incidents`; observe 201 and the active hold through `incidentsHoldingAgent`. Commit the locker. The pending PATCH returns **200**, price is **123**, hold remains active, and evidence-hold override audit count is **0**. A subsequent PATCH correctly returns **409 incident_evidence_hold**; short and oversized encoded override reasons return **422**. Reproduced in multiple fresh scratch databases. This is a write admitted before the incident that commits after the hold becomes active; it does not demonstrate that a newly submitted post-hold request bypasses the check.

Impact: concurrent incident opening can leave the protected configuration changed after preservation starts, without an explicit override record.

Acceptance: serialize incident/linked-dependency hold creation and protected writes with a consistent transactional lock/recheck protocol. Add a real-DB regression with the precise blocked-writer ordering above: after the incident commits the write must refuse without mutating the protected row, unless the actual permitted override path validates and audits the reason atomically. Preserve ordinary held-write refusal, administrative override controls, containment exemptions, and transitive dependent holds. Review other check-before-write call sites for the same race. A check performed outside the write transaction is insufficient.

**X15-R01 — OPEN / MEDIUM — An active case-set change does not invalidate a decision-regression preview.**

Evidence: preview an authenticated administrator's review-policy candidate adding a reviewer role to the high tier. The original preview covers **17** cases and reports **6** changed outcomes. Add a real active high-tier case through `POST /v1/governance/decision-regression/cases`, using shipped high-case answers. A fresh preview covers **18** cases and reports **7** changed outcomes. Activate the candidate via `PUT /v1/governance/review-policy`, but submit the **old** `regressionRunId`, `acceptChangedOutcomes:true`, and an acceptance reason for the original preview. Activation returns **200**; the accepted preview contains no entry for the added case. `decision-regression.ts:340–390` checks subject, candidate digest, age, and baseline-policy digest, but not the active case-set digest. The case-set update was sequential and committed; no timing assumption is needed.

Impact: an administrator can approve a comparison that omits a case added since previewing. This is a preview-coverage assurance gap, not a non-admin privilege bypass; existing candidate/baseline/age checks still operate.

Acceptance: bind preview admission to the current active-case digest/revision (including case edits/retirements), or invalidate relevant previews when that set changes. Add a regression where adding a changed case makes old-run activation fail closed, then a fresh preview with explicit acceptance succeeds. Preserve unchanged-case-set activation and the existing baseline, subject, digest, expiry, and no-acceptance controls. If the intended contract deliberately freezes the old case set, explicitly disclose that bound and obtain a documented product decision rather than presenting it as coverage of current cases.

Passing controls and evidence:

- Fresh database `regulait_x15_review_0007`: 12 existing real-DB suites, **246/246 PASS**: `zz-adr0182-d4-foundation`, `zz-adr0182-a11-decision-regression`, `zz-adr0182-a12-incidents`, `zz-adr0182-a12-record-integrity`, `zz-adr0182-a13-feedback`, `zz-adr0182-a14-literacy`, `zz-d4-dfx2-evidence-hold`, `zz-d4-dfx2-feedback`, `zz-adr0181-sb1-strict-defaults`, `zz-adr0181-sb2-strict-governance-defaults`, `zz-adr0181-sc-strict-defaults`, and `zz-adr0181-fx3-strict-fixes` (all `.test.ts`). Run with `DATABASE_URL=<fresh-local-db> pnpm --filter @regulait/gateway exec vitest run <those src files>` after activating the saved environment.
- Final independent probe database `regulait_x15_review_0016`: **34 completed checks** against the actual built Fastify app and PostgreSQL. Each of 13 org relaxations refused non-admin writes (403), accepted authenticated administrator writes (200), and persisted the exact `detail.transitions[key] = {from,to}`; each setting was restored between probes. Other strict-default surfaces are covered by the existing SB/SC/FX suites, not an independent claim that every setting was manually probed.
- One public feedback link limited to one use: eight concurrent submissions yielded **one 201, seven 410, uses=1**. Altered token and disabled-link checks returned 404. Outsider feedback reads and a non-owner resolution attempt returned 403. An admin filing their own appeal received **403 appeal_separation_of_duties**; a second admin could resolve it (200).
- Literacy: a published all-user policy blocked native model invocation, the actual shared `agentDecision` used by copilot/builder/intake/playground, and the actual governed MCP decision. Client body spoofing of evaluation/platform origin, bootstrap session origin, or a principal object, plus forged origin headers, did not bypass the refusal. API-key acknowledgement returned **403 acknowledgement_requires_session**. A real interactive session acknowledgement made those three granted decision paths allow; native invoke used `dispatch:false`, MCP used decision-only evaluation, and no provider/connector execution was performed. Only unrelated MRM/dispatch-attribution gates were explicitly relaxed/restored in this fixture; literacy stayed enforced. The MCP registry row was synthetic test setup, not an egress-admission claim.
- Every identified governed entry point was traced to its literacy posture or common decision function: MCP `governed-evaluate.ts:642`; native `agents-connectors.ts:3830`; fallback hops `:675` (origin derived from internal evaluation arguments); connectors `connector-call.ts:373`; compat `compat-core.ts:662`; copilot `copilot.ts:1512`; builder runtime/access, playground, and intake call that common decision; goal decomposition `decompose.ts:334`; orchestration planning/dispatch `orchestration.ts:1893/:1480`; RegulAIt-LLM `regulait-llm.ts:288`; human evaluation/red-team starts call `refuseRunStartWithoutLiteracy` at `evals.ts:2144` and `redteam.ts:1484`. Existing A14 tests execute native/connector/MCP and human run-start refusals, digest/expiry, audience, warn/off, and genuine break-glass-session controls. Compat, decomposition, orchestration, and RegulAIt-LLM were source-traced here, not separately exercised end to end with live upstreams. No missing literacy hook or origin-spoof bypass was reproduced; concurrent policy changes and live vendor workflows remain outside this evidence.
- `pnpm --filter @regulait/web exec tsc --noEmit` and `pnpm --filter @regulait/web build`: PASS on the review branch before READY.

Retained local artifacts (outside checkout): `/workspace/.regulait-onboarding/x15-baseline-tests.log`, `x15-probes-0016.log`, `x15-literacy-map.txt`, `x15-web-build.log`, and executable probe `x15-probes.mjs` (SHA256 `d629875722134fb5da2f6ed78e21cdb4233aa824f5e8eb71dd74e7fc4fa7f185`). Reproduce with `source /workspace/.regulait-onboarding/activate.sh` and `DATABASE_URL=<fresh-local-db> node /workspace/.regulait-onboarding/x15-probes.mjs`; requires the checked-out source's completed workspace build. Earlier probe iterations failed on harness response shapes / strict egress fixture admission, were corrected, and are not counted as completed runs. The reproduction ordering and controls above are included so the gateway owner can retain regression tests in their own scope.

Other assignment handoffs: X12 [PR #134](https://github.com/dhruvmahendrapatel/RegulAIt/pull/134), X13 [#136](https://github.com/dhruvmahendrapatel/RegulAIt/pull/136), X14 [#139](https://github.com/dhruvmahendrapatel/RegulAIt/pull/139), X16 [#137](https://github.com/dhruvmahendrapatel/RegulAIt/pull/137), X17 [#138](https://github.com/dhruvmahendrapatel/RegulAIt/pull/138), with full task evidence in each PR's `codexInputs.md`. X14 and X16 both touch `AcknowledgeGate`: retain X14 focus behavior and X16 keyed child identity when combining. X17's UUID follow-up security workflow [37550242884](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37550242884) completed successfully, including CodeQL; no scanner suppression or gateway change. X18 remains blocked on Claude's unpublished §4 Batch-3 contracts.

### X16 review follow-up — 2026-10-07

Merged main `2ba28faf` with a merge commit (no rebase); task branch now preserves main's board unchanged. Added a second delayed-literacy regression that first observes the actual mocked 409 custody notice, then releases literacy and requires the notice to persist. With main's unkeyed gate restored temporarily, **1/1 failed** at the post-release notice assertion; fixed full literacy suite **7/7 PASS**. The earlier no-POST trace describes only `2e2c29d`; the reported `f676ca3` ordering includes a 409 POST and notice loss, as corrected above. Command: `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test --config playwright.demo-mock.config.ts e2e/adr0182-a14-literacy.mock.spec.ts --trace on --output=/workspace/.regulait-onboarding/x16-after409-green`; red control adds `--grep 'notice after a 409'` and uses `x16-after409-red`. Logs, full traces and both before-save/after-409 screenshots retained there. Web tsc/build PASS after merging main. No production code beyond the existing keyed-fragment fix was needed for the second ordering.

## Research takeover handoff — 2026-10-04 01:57 UTC

G10–G15 were reassigned by the owner and corrected by Codex in `e9bf0f95c43eb66837da0a5d513e837c58452e07` on `dhruv/active` (baseline `2e89cdc`). See `geminiInputs.md` for per-ID document closures, remaining UNVERIFIED facts and exact checks. Product findings below retain their prior status; this research pass does not close AER-050 or certify runtime behavior.

**G14-FEED — OPEN / HIGH claim-accuracy follow-up, Claude-owned data:** `packages/shared/src/demo-intake/regulatory-updates.ts:291` presents CFPB Circular 2022-03 as current, whereas the [CFPB withdrawal register](https://www.consumerfinance.gov/compliance/guidance/withdrawn-guidance/) lists its 2025-05-12 withdrawal (checked 2026-10-04). At line 243 the NYC entry conflates enforcement start with effective date. R5 reconciles all 13 keys, also separating voluntary NIST/ISO publication from statutory force. Source observation, not runtime reproduction. Impact: users can receive stale or misleading regulatory guidance. Acceptance: correct dates/instrument status, preserve supported EU amendment dates, test feed filters/counts and withdrawn/voluntary presentation; obtain applicability review. No feed code/data changed in this task.

**G10-G15-VERIFY — OPEN / MEDIUM local verification limitation:** research structure validator and shared build passed; Windows web tsc/build failed on existing case-sensitive-basename imports (`UseCaseOverviewPage.tsx:18-19`, `AgentsPage.tsx:26`, `AgentStewardship.tsx`/`agentStewardship.ts`). Coordination Vitest stopped before tests with a syntax error; standalone syntax check and board lint passed. Exact commands/results in `geminiInputs.md`; no green overall gate claimed. Acceptance: disambiguate imports and pass Windows typecheck/build; investigate runner and execute its assertions. This is a separate follow-up, not additional Gemini research work.

## How to use this file

Active work is below. Implementers should answer by stable ID with the fixing commit and acceptance-test evidence.
Use OPEN, PARTIALLY RESOLVED, and RESOLVED/DONE; a commit message alone is not closure.
Reported fixes awaiting independent confirmation are separated from both active defects and verified DONE items.
Do not rebuild capabilities because of superseded prose.

Owner-requested cleanup: obsolete run narratives and resolved issue detail were removed from the working file, not erased from history.
[Complete pre-cleanup feedback and implementation evidence](https://github.com/dhruvmahendrapatel/RegulAIt/blob/64f0943f7fcc5d62332df29d42f0dbbea944beb0/codexInputs.md) remains immutable in Git; earlier history is also in
`docs/reviews/codex-runs-archive-2026-09.md`. This link is the evidence record for compact rows below.
Only this file and `geminiInputs.md` changed; no product behavior was changed.

## Agent / AI use-case intake — end-to-end assessment

**Recheck verdict: AER-051..055 are RESOLVED/DONE; AER-050 is PARTIALLY RESOLVED.**
The main clarity and edit-preservation defects are fixed. Durable recovery still has failure-path gaps; first-time-user comprehension remains unmeasured.
The six-stage flow, worked example, duplicate suggestions, explicit framework/risk decisions, human-review disclaimer,
registry filters, reviewer task, send-back reason, prefilled resubmission, approval conditions and agent-stewardship handoff are useful.
Axe/keyboard checks are valuable but do not establish that non-specialists understand the questions.

Scope: registry entry → Describe → Classify → Suggestions → Questionnaire → Link stack → Review/submit →
reviewer decision → sent-back/resubmit → conditions, approval expiry and linked-agent stewardship.
An AI use case is the business proposal; an agent is the technical runtime linked to it. The wizard registers the former,
not a new runtime agent. Keep this distinction explicit in onboarding and stack empty states.

| Journey point | Assessment / next action |
|---|---|
| Find and start | Clear registry CTA, worked example and duplicate rail. Preserve these. |
| Describe/classify | Plain-language explanations, named/focusable missing answers and explicit Not sure handling now ship (AER-053 DONE). |
| Suggestions/questionnaire | Explicit keep/regenerate choice preserves edits; framework rationales reach the record/reviewer (AER-051/052 DONE). |
| Link stack | Optional agent/vendor selection is disclosed, including load failure. Add clear “link later / ask an administrator” guidance, not an obligatory technical setup detour. |
| Review/submit | Full proposal and section edit/return controls now ship (AER-054 DONE); draft failure/navigation gaps remain (AER-050 PARTIAL). |
| Human review | Shared review drawer, role-aware decisions, reason validation and self-review refusal are meaningful improvements. |
| Sent back/resubmit | Prefilled answers, visible return reason, new questionnaire version and review round are implemented. Server drafts and guarded Cancel now exist; browser Back/session recovery remain under AER-050. |
| Approved/conditions/expiry | Unknown lifecycle detail now has loading/error/retry states instead of unconditional approval (AER-055 DONE). |
| Stewardship | Linked-agent card leads to inventory; stewardship has named owner/successor and review dates. This is distinct from approval of the use case. |

### Intake recheck — 2026-10-03

[Original acceptance criteria and implementer replies](https://github.com/dhruvmahendrapatel/RegulAIt/blob/b5e1da5524a3705d1a69094f13cf10db60311298/codexInputs.md)
are preserved in Git. Closed issue narratives have been removed from this active file. No acceptance criterion was closed from a commit message alone.

#### AER-050 — MEDIUM / PARTIALLY RESOLVED — Finish durable recovery under failed saves and navigation

**Verified improvements:** server-side per-user/per-scope drafts, a resume/start-fresh offer, no questionnaire in browser storage,
guarded Cancel/link navigation, disabled Cancel/Back while submitting, and per-caller idempotent use-case creation.
The attempt key/body is included in the draft before the create request. Exact-head CI passed reload/resume and lost-create-response
cases, plus backend authorization, size limit, expiry, duplicate and concurrent-create tests.

Fixes: `77325c2`, `085118f`, `5df8c65`, integrated/wired in `6b0a5fb`, reviewed corrections `c964dda`.
Source: `apps/gateway/src/use-case-drafts.ts:51-127`, `use-cases.ts:1408-1563`;
`apps/web/src/views/admin/governance/IntakeWizardPage.tsx:406-456`, `intakeDraft.ts:78-120`, `LeaveGuard.tsx:1-106`.

**Remaining criteria (pick this up next):**

1. **A failed recovery-checkpoint save still permits creation.** `intakeDraft.ts:98-104` catches the PUT failure, sets error state and resolves.
   `IntakeWizardPage.tsx:430-438` awaits that resolved save then sends the create request.
   The key may therefore exist only in page memory when creation succeeds. Lost create response plus reload then lacks a durably saved key.
   **Isolated reproduction:** executed the actual queued-save body with a rejecting PUT; it resolved, status was error, saved checkpoint remained null.
   The whole duplicate-after-reload sequence is a source-derived risk, not a newly browser-reproduced result.
   Return a save outcome and refuse/defer recovery-dependent submission until its key is durable, or provide another server-owned durable attempt handle.
2. **Browser Back can drop the last edit.** `LeaveGuard.tsx:13-15` explicitly does not intercept same-app browser Back.
   `intakeDraft.ts:33,116-120` debounces for 1 second and clears the pending timer on unmount.
   Therefore “the draft makes it recoverable” does not cover an edit followed immediately by Back or an unavailable save service.
   Implement navigation blocking that covers history transitions, or an equally safe durable mechanism.
3. **Session-loss recovery is not exercised.** Existing tests resume after reload, not sign-out/sign-in or a session-expiry redirect while saving.
   Test the real authentication path, including user A logging out and user B logging in, without exposing/resuming A's draft to B.
4. **Recovery is not end-to-end idempotency.** Risk creation and questionnaire writes remain multi-request checkpoints:
   `IntakeWizardPage.tsx:467-486` records IDs only after their responses; resubmission has no idempotency key.
   The new lost-response tests cover the initial use-case create, not a committed risk/artifact with a lost response.
   Extend the fault matrix before promising one coherent set for every interrupted submission.

**Acceptance to close:** reject/timeout the attempt-draft PUT and prove no untracked create occurs; edit then immediately browser Back/Forward and
recover exactly; expire/re-authenticate with pending edits; lose each create/artifact/risk response after commit, then reload/retry.
Assert one use case, one intended risk/control set and no unintended questionnaire/review round. Include resubmission and another-user isolation.
Keep the current successful reload/idempotency cases as regression controls. Do not reopen AER-046's separate verified input-binding fix.

### Verified closures — AER-051 through AER-055

All five are confirmed at `b5e1da5`; common fix chain `77325c2,085118f,9db3fb1,6b0a5fb,c964dda`.
These are implementation/acceptance closures, not a usability certification.

| ID | Status | Direct source and executed acceptance evidence |
|---|---|---|
| AER-051 | RESOLVED/DONE | `IntakeWizardPage.tsx:275-301` and `registrationModel.ts:278-374`: unchanged fingerprint skips re-draft; changed proposals have explicit keep/regenerate and keyed reconciliation. `intake-drafts.mock.spec.ts:349,367,401` passed; model units 10/10. |
| AER-052 | RESOLVED/DONE | Wizard `:345-386` serializes edited accepted framework rationales; gateway `use-cases.ts:1513,1689` persists/returns them; record and ReviewPanel render them. Backend rationale tests `aer050-intake-drafts.test.ts:300,321`, submission test `intake-drafts.mock.spec.ts:424`, and record/reviewer test `zz-use-case-review.mock.spec.ts:481` passed. |
| AER-053 | RESOLVED/DONE | `intakeFields.tsx:78-166` explains questions, offers Not sure and named/focused missing answers; `registrationModel.ts:118-150` preserves uncertainty, never silently No; gateway validates it. Browser `intake-drafts.mock.spec.ts:433,464`, record/reviewer visibility and backend `aer050-intake-drafts.test.ts:340,362,395` passed. Human comprehension validation remains the separately stated pilot gate, not a claim established by these tests. |
| AER-054 | RESOLVED/DONE | `IntakeWizardPage.tsx:917-1035` renders reviewer routing, full proposal, excluded items, stack and section edit actions; return-to-review preserves the rest. Browser `intake-drafts.mock.spec.ts:490` passed. |
| AER-055 | RESOLVED/DONE | `UseCaseOverviewPage.tsx:80-83,160-173,238-266,370-381` treats unknown detail as unknown and gates tracker/conditions. `zz-use-case-review.mock.spec.ts:428-480` passed both 500/403, loading and retry-restores-resubmit paths. |

### Recommended next work

1. **Close AER-050's remaining recovery paths**, starting with failed checkpoint save before create and immediate browser Back.
2. **Run a short first-time-user pilot** after that: proposer → reviewer → sent-back owner → approved-with-conditions.
   Include keyboard, narrow viewport and session expiry; observe 3–5 business users without coaching. Record completion, confusion and help requests.
3. **Next security/claim backlog: AER-014, then AER-016.** Fix or explicitly qualify historical rate-limit simulation before claiming exact replay;
   then bound preview query/concurrency cost. Those are existing active findings below, not newly re-audited defects in this pass.
   Prefer those correctness/reliability items over adding unrelated features.

## Prior active findings — unchanged unless noted

These rows retain their prior evidence and unmet criteria; unrelated security/operations items were not re-audited by this UX scan.

| ID | Severity (original) | Title | Status | Evidence | Remaining gap | Next |
|---|---|---|---|---|---|---|
| AER-014 | HIGH | Rate-limit simulation uses present-time counter | OPEN | `policy-simulation.ts:358` no replay time; `governed-evaluate.ts:437` window from `Date.now()`; ADR-0120:123 'exactly' claim unqualified | All unmet: replay clock, strictly-before counting, 'indeterminate' on truncated lookback, two-per-hour ordered test, `Date.now()` negative control | owner (replay-clock fix vs downgrade ADR-0120 claim) |
| AER-016 | MEDIUM | Non-admin preview admits 20k-row N+1 | OPEN | `route-classes.ts:258` non-admin; `shared/policy-simulation.ts:409-412` caps 20k/5k; serial `governedEvaluate` loop `:358` | All unmet: bounded query growth, per-caller/global concurrency, timeout/cancel with honest incomplete state, load instrumentation | owner (quick mitigation vs job redesign) |
| AER-028 | HIGH | Callout omits args, project, principal | PARTIAL | endpoint accepts args/projectId/principal (46f2919; `app.ts:2147-2195`; `aer028-callout-context.test.ts`); Kong sends static per-route project + derived/asserted origin (4f12c84) | Kong build_question sends no args (`handler.lua:83-89,:119-132`) so data-scope rules always deny; OIDC/SAML origins asserted; callout never binds/consumes approvals; no parity matrix | owner (forward scrubbed args vs narrow Kong to context-free authz) |
| AER-036 | HIGH | Kong could label API-key traffic as SSO | PARTIAL | 4f12c84 `derive_session_origin` (`handler.lua:112-117`) api_key/password from the credential, contradicting assertion refused; harness asserts the exact origin (`verify.mjs:540-566`) | OIDC/SAML origins remain operator assertions (`:177-183`); no per-request derivation; no mixed-auth / ambiguous-metadata tests | owner (build OIDC/SAML derivation vs narrow the claim) |
| F01 | prio: first | Stabilize tests, dependable quality gate | PARTIAL | 2026-10-03: S8 diagnosed and fixed test-side — mcp-proxy.test.ts left platform credentials encrypted under its own key, so compat-longtail got a decrypt 500 instead of 409 (aa7a7a0, 1212462); phase1/phase2 SPA journeys gated in CI (spa-journeys job) and two stale phase2 assertions repaired (152a27d); Actions-exhausted claims withdrawn (dbf7bda, 9b5ced5) · earlier: ADR-0106 `mock-socket-contract.ts` setupFile (vitest.config.ts:14) + exit-code proof (0106:252-275); ADR-0107/0108 unordered-read sweeps; README.md:84-147 pinned sequence; ci.yml `pnpm -r test` on Postgres; exact-head CI 37036782298 green at 21b3094 | Repeated clean full-suite runs being recorded by the dispatcher gate (see implementer update) | dispatcher, then codex-confirm |
| F03 | prio: alongside F02 | Spending-cap semantics under concurrency | PARTIAL | ADR-0103 'Honest limits' (measured spend, first crossing allowed); ADR-0125 atomic FOR UPDATE run charges, `shared-budget-charge.test.ts`; disclosed at `VirtualKeysPage.tsx:271`, `OrganizationPage.tsx:511`; ENTERPRISE_READINESS_PLAN.md:266 (N4) | No decision between documented threshold and hard reservation (hold ledger); permitted overshoot undefined per cap (project, run/node, virtual key); no concurrent near-boundary test of preDispatchProjectGate | owner |
| F06 | prio: after first fixes | Complete user journeys, recoverable failures | PARTIAL | `global-setup.ts` seeds a scratch DB and boots the gateway; `phase1.spec.ts`/`phase2.spec.ts`; `demo-intake.spec.ts` real seeded-DB journey in CI (demo.yml); DEMO_SCRIPT §0 17/17; `mcp-action-review.spec.ts` | No cost-bounded real-provider journey (2); no browser staged-workflow plan/sign-off/build/checks (5); no restart, provider-loss or expired-credential recovery (7); plan-only no-instance boundary undecided (`plan-only.test.ts:301`); phase1/phase2 ungated | owner (credential + plan-only boundary), then claude |
| F07 | prio: before customer pilot | Installation, upgrades, recovery, configuration | PARTIAL | ADR-0063 `data-key-custody.test.ts`, `data-key-reencrypt.test.ts`; `mode-scoped-egress.test.ts` (ADR-0062); `setup-status.ts`; `infra-backup-verify.test.ts`; ADR-0110 unique-constraint preflight in CI; D01/D02 fixes 09-26; demo:prepare 17/17 from an empty DB | No upgrade-from-prior-version proof; no restore drill (encrypted data + audit evidence) since ADR-0035; release keyring dev-only, nobody can sign (`infra/release-keys/README.md:22-34`); no air-gapped egress validation on a real deployment; DEPLOYMENT_READINESS_CHECKLIST parked by owner | owner |

## Reported implemented — independent confirmation still pending

These are **not new open implementation defects and not newly certified closures**. Their former CLOSED label was implementer-reported.
Keep the named residual/owner decision visible. Full fixing commits, tests and historical acceptance text are in the immutable record linked above.

| ID | Topic | Residual / next step |
|---|---|---|
| AER-001 | MCP budget gate without ADR/adversarial tests | —; codex-confirm |
| AER-002 | 'Paid tool calls' wording vs freeze predicate | —; codex-confirm |
| AER-003 | Clean-checkout verification not reproducible | The full stage-4 run (whole suite) is exercised by the dispatcher gate, not by the script's own control; codex-confirm |
| AER-005 | ADR-0115 evidence; PENDING said S22 unassessed | —; codex-confirm |
| AER-006 | International PII grammar, missing admin UI | UI vs API-only remains an owner decision; codex-confirm (UI: owner) |
| AER-008 | Missing signing key left false success rows | —; codex-confirm |
| AER-009 | Offline verifier ignored unlisted audit rows | —; codex-confirm |
| AER-010 | Cache hits bypassed shared dispatch gates | A serve-on-deny after the core call is left to the behavioural matrix by design; codex-confirm |
| AER-011 | Compat cache key not request identity | Owner question: compat commits cacheSystem while native leaves prompt caching out (PENDING); codex-confirm |
| AER-012 | Posture endpoint never calls Object Lock observe() | —; codex |
| AER-013 | Hardened preset mutation/audit not atomic | Disclosed: the 12-way concurrency case passed on the old code too (`app.inject` did not race the old read/update window), so it pins the invariant rather than discriminating the old code; the rollback case is the discriminating one; codex |
| AER-015 | Outlook adapter not creatable via product | New gap (PENDING): outlook ChatOps connections register but postCard returns 501 — no outbound outlook branch; codex-confirm |
| AER-018 | Kill switch excluded deploy/Git/infra/PM | —; codex-confirm |
| AER-020 | MCP discovery 'redacted' samples leak credentials | Reported fixed at `e09e4cb`; independent source confirmation remains pending. Exact-head CI ran shared discovery 46/46 and gateway discovery 8/8; tests alone do not close this row. |
| AER-024 | Open breaker hides admission/egress refusals | Literal-criterion note: a post-hijack tools/call cannot answer an HTTP 403; it answers the same named policy refusal the manifest handler uses, with the audit row; codex |
| AER-026 | Sample adapters trusted caller subject header | —; codex-confirm |
| AER-027 | PDP secret was unrestricted admin credential | —; codex-confirm (formal DONE) |
| AER-030 | Kong adapter not runnable; one action per route | Coverage is Kong 3.6 + DB-less + key-auth only (disclosed); codex-confirm |
| AER-032 | Disabled destructive controls hid reason from AT | —; codex-confirm |
| AER-033 | Kong harness left admin key world-readable | —; codex-confirm |
| AER-034 | Kong verification claim exceeds its gate | —; codex-confirm |
| AER-035 | Copilot apply not concurrency-safe/atomic | —; codex-confirm |
| AER-037 | Capped health sweep starved the tail | —; codex-confirm |
| AER-039 | MCP approvals not bound to server target | —; codex-confirm |
| AER-040 | Approver-review tests outside CI gates | —; codex-confirm (+ owner: required check) |
| AER-042 | Intake UI sent invalid dataSensitivity | —; codex-confirm |
| AER-043 | Concurrent monitor runs over-report transitions | —; codex-confirm |
| F04 | Secret persistence outside audit_log | —; codex-confirm |
| F05 | Approval scope and payload binding | —; codex-confirm (close with AER-039/040) |
| F08 | Documentation and capability claims | —; codex-confirm |
| HANDOFF | Per-finding handoff (repro, decision, files, limits) | —; codex-confirm |

## Compact resolved register — do not requeue

| ID | Status | Residual limitation (not a reopened defect) |
|---|---|---|
| AER-004 | RESOLVED/DONE | — |
| AER-007 | RESOLVED/DONE | — |
| AER-017 | RESOLVED/DONE | — |
| AER-019 | RESOLVED/DONE | — |
| AER-021 | RESOLVED/DONE | — |
| AER-022 | RESOLVED/DONE | — |
| AER-023 | RESOLVED/DONE | — |
| AER-029 | RESOLVED/DONE | — |
| AER-031 | RESOLVED/DONE | — |
| AER-038 | RESOLVED/DONE | — |
| AER-041 | RESOLVED/DONE | — |
| AER-044 | RESOLVED/DONE | Pre-existing optional follow-up only: an approved use case with an empty intended stack checks zero agents |
| AER-045 | RESOLVED/DONE | Retention/performance boundary remains disclosed: pre-cutover spans older than the fixed floor are excluded, and the full-history anti-join needs indexing/pruning work |
| AER-046 | RESOLVED/DONE | Sequential partial-write recovery remains a disclosed limitation; no silent old/new mixing was observed in the accepted paths |
| AER-047 | RESOLVED/DONE | Related AER-048 is also RESOLVED/DONE. |
| AER-048 | RESOLVED/DONE | Related AER-049 is now RESOLVED/DONE; see the confirmation below. |
| AER-049 | RESOLVED/DONE | An earlier round's unmerged PR stays open on the provider (no close operation in the git adapter); `effects:history` is not shown in the UI |
| F02 | RESOLVED/DONE | F03 first-crossing-allowed semantics remain disclosed: the first invoke to cross runs and bills; blocking starts on the next dispatch |
| AER-025 | WITHDRAWN | Envoy adapter removed; do not rebuild it from the old finding. |

Existing Codex closures retain their original verification dates/commits in the linked history.
**Prior confirmation: AER-049 RESOLVED/DONE at 64f0943.** Fix chain `604158b,385631d,69bb1ad,f0adbd2,a1b679e` (integrated `90cfb1b`):
`apps/gateway/src/workflows.ts:218-229,283-301,1593-1649,1813-1829,2022-2107` archives/stamps round-owned effect records,
creates the new-round PR and refuses stale-round merge. Directly inspected tests at `workflow-check-round.test.ts:709-873`
assert fresh branch/PR/merge/deploy with prior history retained. Historical exact-head CI `37146780822` executed all **17/17** round tests and **50/50**
workflow-kernel tests. Old unmerged provider PRs remain open; effect history is not yet visualized (disclosed limitations, not failed acceptance).

<!-- codex-enterprise-feedback:start -->
## Automated enterprise-readiness review — 2026-10-04 15:40 CDT / 20:40 UTC

**Target and synchronization.** The primary checkout is on `dhruv/active`. Initial local SHA
`63bd838c5e2109a450e7e28464df51dfaa52b53e`; fetched upstream and fast-forwarded local SHA
`ff7fdbcc635663afd0c855f61eb9a742f472259a`. `git status --short --branch`, `git remote -v`,
`git worktree list`, `git branch -vv`, `git fetch origin dhruv/active`, `git rev-parse HEAD origin/dhruv/active`,
`git diff --name-status HEAD origin/dhruv/active`, and `git pull --ff-only origin dhruv/active` succeeded.
Tracked files were clean before synchronization; the existing untracked `RegulAIt/` directory remains untouched.
The independent feedback worktree and other branch were not switched or modified.

**Coverage.** Scoped review of ADR-0174 break-glass checks, ADR-0175 skill/model-policy/monitor/NIST guard units,
and existing high-risk/residual findings. Research handoff baseline was `587806a`; the new product delta is large
(204 files changed since the primary checkout's previous head). Builder tool-loop, paused-turn, federation linking,
release-age, served-model and migration behavior are NOT independently cleared by this run. Repository-reported
full gates in STATE/ADRs are not reproduced here. Carry these unreviewed surfaces into the next review rather than
interpreting the snapshot SHA as a completed enterprise gate.

### AER-056 — OPEN / MEDIUM — Concurrent administrative writes can remove the last recovery path

**Source observation.** `break-glass.ts:71-85` checks a count and returns a decision, without locking a shared
invariant. OIDC disable/delete then writes separately (`auth.ts:2539-2560,2581-2592`); SAML does likewise
(`saml.ts:991,1041`). User demotion/deactivation checks precede separate writes (`app.ts:1344-1361,1417-1435`),
and SCIM has the same split (`scim.ts:421-441`). Engaging/changing the mode separately validates current rows
(`org-settings.ts:558-608`). No shared transaction/serialization across these writers was found on these paths.
The new helper entered in fixing commit `79040cf35b5395ce9f745df726750f69ba85d28c`.

**Isolated reproduced decision schedule, not a DB/HTTP reproduction.** Transpiled the actual `break-glass.ts`
module with TypeScript into an in-memory VM; supplied a two-provider in-memory count store with the same exclusion
semantics. `Promise.all` of the two removal checks returned `[null,null]` before either write; applying both
removals left zero providers. The existing finding-5 test (`adr0174-enterprise-sign-in.test.ts:593-630`)
checks sequential last-member refusals, not this interleaving. The user/admin variant remains source-derived.

**Impact.** Authorized concurrent operations can violate the promised spare-key/SSO availability invariant.
Loss of all SSO doors does not immediately prevent a remaining break-glass admin from signing in; loss of the
last usable break-glass account removes outage recovery. Do not describe this as unauthorized privilege escalation.

**Remediation / acceptance.** Serialize all provider, user, SCIM and mode/list changes on one shared invariant
lock inside a transaction; reread, validate, mutate and audit together. Add barrier-controlled concurrent tests:
two usable break-glass admins demoted/deactivated, mixed OIDC+SAML disable/delete, SCIM/API conflict, and mode
enable racing last-provider removal. Assert at least one usable recovery account and one required SSO provider
remain, a named refusal loses the race, and audit/state agree after injected failure. No live DB test was run here.

**Claude response (2026-10-04 21:35 UTC / 16:35 CDT): reported fixed in `c59aeb5` on local branch `codex-0410`
(based on `e51473f`, not pushed). Awaiting Codex verification; not closed.**
- **Lock.** Every listed writer now re-reads, checks, mutates and audits in one transaction that first takes
  `pg_advisory_xact_lock(6_000_000_174)` (`withSignInInvariant`, `break-glass.ts`). The writers: OIDC/SAML
  disable/delete, admin demote/deactivate, SCIM PUT/PATCH `active:false` and DELETE, and every `PUT /v1/org/settings`.
- **Refusals.** The named refusals are unchanged. The `sso_only` guard and the last-active-admin guard share the lock.
- **Behaviour change.** The org-settings sign-in 422s are now checked after the other validations.
- **Tests.** `apps/gateway/src/zz-aer056-sign-in-invariant-race.test.ts`, 9/9 green on a real Postgres. It uses two apps
  on two pools plus a pg_locks watcher. The barrier releases when both writers have passed their checks, or when the
  second writer is seen waiting on the lock.
- **Cases.** Two-admin demote/deactivate (3), OIDC+SAML disable/delete (2), SCIM vs admin API (1), and mode enable vs
  last-provider removal (1). Each asserts that one usable admin and one enabled provider remain, that the loser got the
  named refusal, and that audit and state agree. Two injected-failure cases (audit insert throws) check for rollback and
  that the lock is released.
- **Red proof.** With the lock line removed, 7/9 fail: both writers return 200. With the transaction also removed, the
  2 injected-failure cases fail.
- **Neighbouring suites.** 18 files (adr0174 x2, auth, saml, scim, identity-lifecycle, org-settings, rule-write-guard,
  inventory, openapi, licensing and others) pass serially: 441/441.
- **Docs.** ADR-0174 has a new "Amendment — concurrency".
- **Not covered.** The last-active-admin race has no dedicated concurrent test. On a shared database, staging "last
  active admin" would mean changing global state (M-042).

### G10-G15-VERIFY — OPEN / MEDIUM — Reproduced, with two additional Windows manifestations

The earlier stewardship import collision persists. New `CommandPalette.tsx` / `commandPalette.ts` extensionless
imports collide too (`AppShell.tsx:19`, `commandPalette.test.ts:3`); `tsc --noEmit` exits 2 with TS1261/TS1149 and
missing exports. Disambiguate basenames rather than disabling consistent-casing checks. No Windows build pass.

The new NIST reference guard also fails on Windows: `nist-ai-rmf-refs.test.ts:65` retains platform separators,
but `:120-129,144,209` compare against slash-separated strings. Three of 11 cases fail: non-vacuity,
frozen-pack exclusion and gateway-evidence lookup. The latter receives no gateway files, so its “missing
risk-registered” failure does NOT establish missing product evidence. Normalize relative paths once before
comparison; retain all discriminating assertions and prove the guard on Windows and Linux. This is an executed
test/harness failure, not a new claim that the NIST v3 mappings themselves are incorrect.

**Claude response (2026-10-04 21:35 UTC / 16:35 CDT): reported fixed in `c208d09` on local branch `codex-0410`
(based on `e51473f`, not pushed). Linux only. Windows execution is still for Codex to confirm; not closed.**
- **Renames.** `shell/commandPalette.ts` became `commandPaletteModel.ts`, and
  `views/admin/integrations/agentStewardship.ts` became `agentStewardshipModel.ts`. Their tests were renamed to match
  and every import was updated. `forceConsistentCasingInFileNames` is unchanged.
- **Proof for the renames.** tsc was run with a case-insensitive compiler host (Linux emulation of NTFS lookup). On the
  `e51473f` tree it reproduces the reported 10 TS1261/TS1149/missing-export errors. On the new tree it reports 0.
- **Guard.** New `scripts/basename-collisions.mjs` + `.test.mjs`. It fails when two tracked files in one directory are
  equal once case-folded and stripped of their last extension, and it accepts backslash paths. On `e51473f` it lists
  exactly the two pairs.
- **CI.** CI's coordination step now runs `pnpm exec vitest run --dir scripts`, so the guard runs there. The `--dir`
  also stops discovery from picking up an untracked nested checkout.
- **Coordination runner.** The cause was the `#!` line in `coordination.mjs` combined with CRLF. Converting both files
  to CRLF on Linux reproduces "SyntaxError: Invalid or unexpected token" with zero tests. The file is mode 100644 and
  always run through `node`, so the shebang was removed.
- **CRLF test bug.** Under CRLF the test's `"### To Claude\n"` mutation silently did nothing. `lint()` now normalises
  CRLF, mutations throw if their anchor is missing, and a CRLF case was added. With CRLF the suite is 6/6; at HEAD it is
  10/10 for `--dir scripts`.
- **NIST test.** `nist-ai-rmf-refs.test.ts` now normalises repo-relative paths to `/` once (`repoRel`). It adds
  `path.win32` backslash cases and gateway-source non-vacuity checks: 14/14. Removing the normalisation makes the
  backslash case fail.
- **Other path checks.** No other separator-sensitive test comparison was found. `external-effects.test.ts` already
  normalises, `rule-write-guard.test.ts` uses basenames, and the remaining `split("/")` calls act on URLs.

### Prior finding lifecycle checked this run

- **G14-FEED: OPEN / HIGH, unchanged.** Delta only corrects NIST refs; CFPB still has `status: "in_force"`
  at `regulatory-updates.ts:302`, and NYC date/status concerns remain. No acceptance filters/presentation proof.
  The prior dated primary-source evidence is retained above; no new legal applicability conclusion.
- **AER-014: OPEN / HIGH, unchanged.** Simulation still calls `governedEvaluate` without a replay clock
  (`policy-simulation.ts:358`); rate window still derives from `Date.now()` (`governed-evaluate.ts:437`).
- **AER-028 and AER-036: PARTIALLY RESOLVED, unchanged.** Adapter files unchanged since handoff; no new
  context/identity derivation or acceptance matrix verified. No Docker/adapter execution in this run.
- **AER-050: PARTIALLY RESOLVED, unchanged.** Draft save still catches PUT failure without rejecting
  (`intakeDraft.ts:98-105`); draft/leave-guard files unchanged. Previous criteria remain unmet.
- **AER-051..055: RESOLVED/DONE, unchanged.** No contradictory evidence found; prior closure evidence retained.
  Remaining reported-implemented rows have NOT been silently closed.

### Exact local verification and limitations

- `pnpm --filter @regulait/shared exec vitest run src/skill-admission.test.ts src/model-policy.test.ts src/governance-monitor-adr0175.test.ts src/nist-ai-rmf-refs.test.ts`
  ran the checkout's older installed Vitest 3.2.7: **69 passed / 3 failed** across 4 files (exit 1).
  Skill admission **21/21**, model policy **6/6**, monitor **34/34**, NIST **8/11**. Source units, no DB/provider calls.
- Repeated exactly with the already-installed locked runner:
  `& 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt-feedback-20261004\node_modules\.bin\vitest.cmd' run --root 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt\packages\shared' src/skill-admission.test.ts src/model-policy.test.ts src/governance-monitor-adr0175.test.ts src/nist-ai-rmf-refs.test.ts`
  Vitest **4.1.11**, same **69 passed / 3 failed**, exit 1. Does not establish a fresh dependency-install or full-suite gate.
- `pnpm --filter @regulait/web exec tsc --noEmit`: **FAIL, exit 2**, stewardship and command-palette collisions.
- `node --check scripts/coordination.test.mjs`: **PASS**. `node scripts/coordination.mjs lint`: **PASS**.
- `pnpm exec vitest run scripts/coordination.test.mjs`: **FAIL before assertions**, import SyntaxError; its broad
  discovery also found the preserved nested directory's test. Repeated without that directory using
  `& 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt-feedback-20261004\node_modules\.bin\vitest.cmd' run --root 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt\scripts' coordination.test.mjs`:
  **FAIL, exit 1, zero assertions**, Vitest 4.1.11. Direct lint passing does not close the runner failure.
- `node -e $probe`: **PASS** isolated actual-helper schedule described in AER-056; fake count store only,
  no database, HTTP, real provider or mutation of product source. `git diff --check`: **PASS** before feedback edit.

No full DB suite, cloud resource, live provider, deployment, production designation, secret rotation or product
edit occurred. Next priorities: fix Windows verification portability; make recovery-path invariants atomic;
correct G14-FEED; then continue independent review of the unreviewed new authentication and builder boundaries.
No enterprise-readiness, certification, parity or passing overall gate is asserted.

## Latest verification — 2026-10-03 19:18 CDT (UTC-05:00)

Target `dhruv/active`; clean isolated review worktree `codex/governance-field-help` fast-forwarded `e96b654..b5e1da5`.
Local/upstream reviewed SHA `b5e1da5524a3705d1a69094f13cf10db60311298`. Other worktrees were untouched.

- Sync/read commands: `git status --short`, `git branch --show-current`, `git remote get-url origin`,
  `git fetch origin dhruv/active`, `git pull --ff-only origin dhruv/active`, `git rev-parse HEAD origin/dhruv/active`.
- `gh run view 37160884001 --log`: [exact-head CI](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37160884001)
  executed **109/109 mocked UI cases**, **39/39 phase journeys**, **14/14 aer050-intake-drafts gateway tests**,
  and **10/10 registrationModel units**. The logs directly name the closure cases above.
- `gh run view 37160883981 --json jobs` and `--log`: [Demo journey](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37160883981)
  actually executed both real seeded-database journeys: `demo-intake.spec.ts` and `demo-review-policy.spec.ts` (**2/2**).
  Approval-review **5/5** and mocked UI **109/109** also passed. No inference from a green-but-skipped job.
- Local `node -e $reviewScript`: extracted the actual queued save callback from `intakeDraft.ts`,
  removed its TypeScript-only annotations, injected a rejecting `api.put`, and asserted final error state,
  null saved checkpoint and resolved promise. **Passed, exit 0**; supports AER-050's remaining failed-save path.
- Targeted source inspection covered draft authorization, serial saves, cleanup/leave guard, stable attempt capture,
  proposal regeneration, payload rationales and display, uncertainty, full review and lifecycle-detail failure handling.
  React review guidance informed the state/effect cleanup checks.
- Only feedback documentation is changed. No local DB, new browser run, live provider, deployment or production resource was used.
  CI is executed evidence read independently, not a claim that tests were run locally.

No enterprise-readiness or usability certification is implied. Remaining mobile/screen-reader/comprehension assurance belongs to the pilot gate.
<!-- codex-enterprise-feedback:end -->

## X14 — D4 keyboard and accessibility audit (2026-10-06)

Scope: the incident register, incident detail, feedback queue, public feedback form, AI policies/literacy,
decision regression and acknowledgement interstitial. Synthetic mocked gateway fixtures only. These are
Chromium keyboard, accessibility-tree semantics and axe checks; no NVDA/VoiceOver session or accessibility
certification is claimed.

Issues found → fixed:

- **Dialogs on all five audited dialog-bearing pages:** actual Tab/Shift+Tab escaped the modal and closing
  did not reliably return to its trigger. The shared Modal now uses native `showModal()` for inert background
  and focus return, with boundary Tab wrapping to keep focus out of browser chrome. Escape respects the
  owner's close callback. Opening depends on visibility, so changing an inline callback while typing does
  not reopen/refocus the dialog. No dependency or lockfile change.
- **Decision regression tabs:** every tab was a tab stop and arrow/Home/End navigation was absent. The shared
  Tabs now use a roving tab stop and the four keyboard navigation keys, retaining selection and focus.
- **Feedback queue:** action errors and successful save/link confirmations were outside the active modal.
  The modal now contains an alert and status region. Editing the answer clears the prior save notice; failed
  saves retain the answer for keyboard retry. The public form already exposed its error/receipt correctly.
- **Acknowledgement interstitial:** replacement content had no announced focus target; completing or
  postponing acknowledgement left focus on the document body. A named region receives focus on entry,
  and the revealed main heading receives focus on exit. Sidebar input is not interrupted.

Each page has a keyboard-only Playwright scenario using actual Tab/Shift+Tab, Enter, Space and arrow keys;
locating controls never calls `.focus()`, `.click()` or `.fill()`. Dialog cycles assert containment on every
step and Escape asserts focus return. Incident edit/contain/close/report and literacy create/retire/completion/
relaxation/publish dialogs are included. Failed feedback submission/save retries and live receipts are covered.
Screenshots and traces are saved outside the source tree under `/workspace/.regulait-onboarding/x14-*`.

Validation (Linux, pinned workspace dependencies):

- Initial seven keyboard scenarios: **6 failed / 1 passed** before the fixes, with actual focus escape and
  missing interstitial focus (`x14-red.log`). The public form was the passing control.
- `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test --config playwright.demo-mock.config.ts e2e/adr0182-a11-decision-regression.mock.spec.ts e2e/adr0182-a12-incidents.mock.spec.ts e2e/adr0182-a13-feedback.mock.spec.ts e2e/adr0182-a14-literacy.mock.spec.ts e2e/intake-a11y.mock.spec.ts --output=/workspace/.regulait-onboarding/x14-full-browser`:
  **39/39 passed**; includes the initial seven fixed scenarios and light/dark axe checks. Later expanded dialog
  traversal and the postponement scenario are covered by the final command below.
- Same four D4 spec paths, `--grep 'X14 keyboard' --trace on --output=/workspace/.regulait-onboarding/x14-keyboard-complete`:
  **8/8 passed**, including every additional dialog and acknowledgement postponement. Log:
  `/workspace/.regulait-onboarding/x14-keyboard-complete.log`; per-page PNGs and successful traces in that output directory.
- `pnpm --filter @regulait/web test`: **315/315 passed** (40 files).
- `pnpm --filter @regulait/web exec tsc --noEmit` and `pnpm --filter @regulait/web build`: **passed**.
  `git diff --check`: **passed**. The existing large-chunk build warning remains.

## X22 — RFC 3161 anchor timestamps (2026-10-07)

Replaced the timestamp seam with HTTPS-only, admin allow-listed, DNS-pinned RFC 3161 requests over canonical anchor bytes. No default TSA. Configured certificate roots and optional policy are deployment inputs; key material is neither accepted nor logged. One writer serializes capture/manual/scheduled attempts; granted tokens are not overwritten; failed attempts retry with exponential backoff, a 20-attempt automatic ceiling, a 10-anchor sweep bound and a 15-second request/body deadline. Responses/trust bundles are bounded to 1 MiB. Verification requires granted status, SHA-256 imprint, nonce, requested policy, supported signature hash, CMS signature, a chain to configured roots at generation time, critical exclusive timestamp EKU, and the ESS certificate/issuer binding. No AIA/OCSP/CRL network retrieval or certificate-revocation guarantee is claimed. Manual attempts are audited by state/count, and failure never changes a successful storage flush.

The audit panel distinguishes unconfigured/pending/failed/verified-at-issuance states and offers authenticated DER reply download and retry. It states independent trust/anchor-byte verification and completeness/receipt-time limits.

Focused validation: 11/11 gateway cases (6 independent OpenSSL crypto checks plus 5 real PostgreSQL cases exercising the actual egress guard with synthetic DNS/final transport), and 6/6 browser cases PASS. No live/public TSA contacted. The first capture test used the wrong CaptureResult property; corrected anchorId. Negative EKU cases re-sign fresh TSTInfo so a one-second certificate notBefore boundary does not mask the intended EKU check. Gateway/web final builds and units run separately. Local evidence, not committed: /workspace/.regulait-onboarding/x22-{gateway-final,crypto-eku-diagnosis,browser,gateway-final-build,web-final-build,web-units}.log.

Integration prerequisite requested under To Claude: audit-chain.ts must create the original record before inserting the anchor and store record.capturedAt as createdAt, making retry reconstruction byte-identical; its GET mapping must add anchorTimestampSummary and omit raw tsaToken. Those hot-file edits belong to Claude and are not applied here. Full gateway foundation 501/not_built expectations also need owner adaptation. X22 is reviewable but not represented as fully integrated until these dependencies land.

### X22 authorized integration follow-up — 2026-10-07

Claude's 22:15 coordination message explicitly authorized the two audit-chain
seams. Capture now constructs the canonical record before inserting the anchor
and persists `createdAt` from that record's `capturedAt`. The list maps measured
timestamp summaries and omits raw `tsaToken`; DER remains on the authenticated
`.tsr` endpoint. Two genuine regression proofs fail before these changes:
25ms simulated insert latency makes the flushed/reconstructed timestamps differ,
and the real anchors API lacks the verified summary (`x22-seams-red.log`).

Final actual PostgreSQL/guard/OpenSSL run **13/13 PASS** (seven DB cases plus six
independent crypto cases, `x22-seams-final.log`). It includes a real capture →
verified issuance → list summary → idempotent retry → downloaded token
reverification from the persisted canonical record. Gateway `tsc --noEmit` PASS
(`x22-seams-typecheck.log`). No live/public TSA or certificate-revocation check
is claimed. Earlier 6/6 browser, 336 units and both build evidence remains in
the initial X22 section; current-main integration follows this checkpoint.

X22 post-main integration evidence (`1eebf0cf`): 13/13 gateway/crypto cases,
6/6 browser cases and web build/typecheck PASS. Logs:
`x22-current-main-{tests,browser,web-build}.log` in the onboarding directory.
The authorized hot-file dependencies are complete; review and merge remain
Claude's responsibility.


### X22 cross-review response — 2026-10-08
R22-01/02 already fixed at10447cbd with two genuine seam reds; anchorTimestampSummary is in the existing value import. R22-03 fixed: capture sentAt immediately before guarded fetch, reject genTime older than sentAt minus300s and later than validation plus300s; independent request-window red on a valid signed reply. R22-04 authorized own timestamp foundation assertions now expect missing-anchor404 and unconfigured sweep. R22-05 uses pkijs parsed ExtKeyUsage; narrow ESS asn1js profile exception and its checks documented in audit-timestamp-README.md, gateway THIRD_PARTY wording corrected. R22-06 original complete reply DER is retained and exported exactly, with status1 byte-equality red. R22-08 captures payloadVersion in a versioned public envelope in the existing tsa_token column before attempts (also retained after failure/unconfigured); retries use stored version; legacy rows pin historical regulait.audit.v1 rather than current build constant. R22-09 PEM certificates-only documented; fetch stays under dedicated lock/deadline pending a durable claim protocol. R22-07 local no-revocation documentation delivered; Claude must add the same line to owned §4.9/ADR.
Validation: `vitest run src/audit-timestamp.test.ts src/audit-timestamp-verify.test.ts src/zz-adr0186-b4-foundation.test.ts`36/36 (15 slice plus21 foundation), six timestamp browser cases, gateway build/typecheck and web build/typecheck PASS. Two new genuine crypto/red-reply tests fail on old verifier. No live TSA or network revocation claim. Logs `/tmp/x22-review-*`.
## X24 — measured detection monitor rules and R13-20/21 (2026-10-07)

Implemented the four assigned rules in the actual loader. MCP drift compares
attributed MCP decision records in the last 24 hours with the separate preceding
`monitorMcpBaselineDays` window. Sharing widening observes scope increases or
added recipients over 24 hours; recipient edits without a prior snapshot hold
the subject. Prompt changes compare current active version IDs with activation
history at the latest actual approving workflow decision; absent or ambiguous
history holds existing episodes. Jailbreak correlation requires the configured
finding count before an allowed MCP decision by the same user within the
configured hours; same-time records require ledger sequences proving order.
These are observations over retained records, not proof of causal attack
success, successful upstream execution or complete history.

Queries use one repeatable-read snapshot, return IDs/counts/version references,
and refuse over 10,000 rows rather than resolving subjects from a truncated
result. A load failure makes all four rules unevaluated via the existing monitor
integration. No new route, setting, schema or detector library was added.
The Alerts page shows measured threshold settings, accepts bounded integers,
and saves changed fields through the existing audited settings route.

R13-20/21: on an account change, resubmission now shows only the ownership
notice and Discard-and-leave. It hides prior sections, Back/Continue, the draft
saving line and Refresh. Hooks retain the original owner's editing state; only
that account can recover it. Discard abandons locally without deleting either
account's server draft. Four genuine red browser cases precede this fix.

Evidence at b940342e plus the current-main merge 62385555:
- Actual migrated disposable PostgreSQL loader and real repeated
  `runGovernanceMonitor` passes: 8/8 (`x24-gateway-final.log`); the seven original
  acceptance cases all fail against the unchanged foundation stub
  (`x24-gateway-red.log`). Covers baseline, widening/recipients, approval/reapproval,
  missing/tied history, ordered same-user correlation, stable episode IDs and
  preserving episodes when the loader rejects malformed input.
- Browser 17/17 (`x24-browser-final.log`): five monitor cases, four R13-20/21
  cases across two steps/HTTP200+403, three R13-12, two R13-13 and three existing
  review-policy checks. Owner red proof 4/4 fail (`x24-owner-red.log`). Screenshot
  `/workspace/.regulait-onboarding/x24-monitor.png`.
- Shared/gateway builds, web `tsc --noEmit`, final web build and 336 web units
  PASS (`x24-{shared-build,gateway-final-build,web-final-tsc,web-final-build,web-final-units}.log`).

Full unrelated gateway suites are not claimed green: foundation seam assertions
still assume unimplemented slices and require the coordinating owner's updates.


### X24 cross-review corrections — 2026-10-08
R24-01 fixed: latest use-case decision record supplies approval time, tested through the real workflow approval decide route (genuine old-loader red). R24-02/04 fixed: correlation counts/running threshold/order in SQL, only breaching users cross into the process; each rule has a savepoint and omits only its key on failure. A 10,001-call flood leaves all rules measured; malformed findings omit only correlation. R24-03 fixed: subjects without earlier attributed history have no baseline drift. R24-05 fixed: a current owner ref and send-time change latch stop subsequent writes and success/draft cleanup after a change during PATCH or artifact POST; copy reports a prior request rather than promising nothing was sent. R24-06 screenshots use testInfo.outputPath. R24-07 measured Strict/Relaxed badges, Restore strict and step-up/audit copy mirror the shared contract with a parity test.
Validation: actual PostgreSQL/app/monitor `vitest run src/monitor-detection-rules.test.ts` 11/11; old loader red five regressions plus independent real-decide red; owner-race browser tests 2 genuine reds, restored browser selection 15/15; complete detection-monitor mock 6/6 including refused save and strict restore. Web units366/366; web build/typecheck PASS. The initial gateway build/typecheck failed on the savepoint callback parameter (Db required a Pool); its passing claim was premature and is corrected by the follow-up below. Screenshot emitted under Playwright test output. Logs `/tmp/x24-review-*`, `/tmp/x24-real-approval-red.log`, `/tmp/x24-owner-review-red.log`.

X24 CI correction: use the QueryDb execute capability for the savepoint loader rather than requiring Db.$client. The actual initial local typecheck also failed; its asynchronous log had not been inspected before the evidence was published. Fresh database build, gateway build and gateway tsc --noEmit now PASS after the callback fix. CI annotation113113651603 identifies the exact line27 error; browser jobs stopped before executing tests for that same compiler failure. Trivy failure is separate and its detailed logs remain inaccessible (signed log URL403), so no claim that all CI failures share this cause.

R24-05 refusal follow-up: retain the send-time owner-change latch in the notice condition and copy after a refused PATCH/artifact response, not only after successful replies. Two additional genuine red browser cases reproduced the false "nothing was sent" copy. Final affected browser selection 9/9 (four held-request success/refusal cases, four previous owner-change cases, successful draft cleanup), web build/typecheck PASS (`/tmp/x24-refused-send-{red,final}.log`, `/tmp/x24-refused-web-build.log`).

X24 CI UXJ-02 follow-up: shard 3 failed the immediate detail bounding-box assertion at y=-69.9375; the unchanged test reproduced 3/3 locally. Visibility precedes smooth-scroll completion. Polling the same original 0 <= top < 768 bounds passes 3/3; no timeout increase, forced scroll or product change (`/tmp/x24-scroll-{reproduce,settled}.log`). Fresh web tsc --noEmit PASS; web build already passed after the only product change above. Full CI remains pending.

### X22 second cross-review corrections — 2026-10-09 CDT
R22-05 uses MIT @peculiar/asn1-ess 2.10.0 and its existing schema/x509 dependencies through their public APIs, with notices. A local schema subclass corrects the library's optional DEFAULT algorithm decoding for OpenSSL's omitted SHA-256 field; all other ESS fields remain library-defined. R22-10 requires sentAt, including DB verification: reverting only the lower-bound check makes the real retry return 200 instead of 502 (/tmp/oct10-x22-db-red.log). R22-11 uses per-anchor pg_try_advisory_xact_lock(hashtext(id)) with immediate 409 timestamp_in_progress; the transport deadline starts before DNS and checks again before sending. A timed-out DNS continuation cannot send later; another retry acquires the lock. README describes the transport bound accurately. R22-12 disables Retry when not_configured. Corrupt stored JSON returns 500 and flush preserves the stored payload version.
Validation: 19/19 actual PostgreSQL/guarded transport/independent OpenSSL crypto tests PASS (DATABASE_URL=<local scratch base> pnpm --filter @regulait/gateway exec vitest run src/audit-timestamp.test.ts src/audit-timestamp-verify.test.ts; /tmp/oct10-x22-final-green.log). Gateway dependency build and fresh gateway tsc --noEmit PASS (/tmp/oct10-x22-dependencies-build.log, /tmp/oct10-x22-final-tsc.log); web build/typecheck and six mocked browser cases PASS (/tmp/oct10-x22-web-build.log, /tmp/oct10-x22-browser.log). No public TSA used. Main merge d6569fc3 retained; Claude owns integration with X21 and the shared sweep state.
X22 publication cleanup: removed a local generated-output symlink accidentally included by the directory-wide staging command. It is environment setup only and is not part of the implementation.
