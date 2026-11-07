# Whole-build review: `main` at 6a06dc1 (2026-11-07)

**Scope.** This is an independent review of the whole product as it stands on `main` at merge commit 6a06dc1 (PR #628). It is not a PR review. The reviewer reports and does not fix. The review changed no code, made no comments on other PRs, and wrote nothing to any cloud account.

**Method.**
- Four parallel read-only passes:
  - pillar fit;
  - the ADR-0200 security checklist;
  - code health, migrations and the open-source-first rule;
  - process and product readiness.
- Then an adversarial pass: one skeptic per top-eight finding cluster, each told to refute the finding against the code. Where a skeptic corrected a claim, the corrected wording is used below.
- History counts cover 2026-10-17 to 11-07, from a deepened clone.
- No test suite was run.
- **UNVERIFIED** marks any claim not re-read in code at 6a06dc1.

**Not a compliance statement.** Nothing here is a claim of compliance or certification against any standard.

---

## Executive summary

1. **The build is broad, and in places it is narrower than the docs say.**
   - Every pillar has routes, tables, UI and tests.
   - Pillars 2 (workflow), 4 (shared context), 5 (cost) and 7 (orchestration) are substantially built.
   - Pillars 1, 3, 6 and 8 are partial against what CLAUDE.md claims (P-01 to P-04).
2. **Governance is uniform only for MCP calls.**
   - Approval rules, kernel rate limits and Cedar ABAC reach MCP tool calls only.
   - Model calls get allow or deny, and model rate limits are off by default.
   - Connectors have no governance rate limit.
   - A2A calls never call the policy kernel.
   - ARCHITECTURE.md's "one decision core" diagram is inaccurate for model, connector and A2A calls (P-01, S-05).
3. **The "forced" plan-only gate is opt-in.**
   - An invoke that omits `instanceId` runs `execute` while its project's instance is in planning.
   - A test pins this behaviour.
   - IDE (compat) and MCP calls never meet the gate (P-02).
4. **RLS covers 4 of 338 tables and is enforced on none at runtime.**
   - The gateway never calls `withPrincipal`.
   - The shipped login is a superuser.
   - No boot check refuses a superuser login.
   - CLAUDE.md treats this as a blocking bug (S-01).
5. **The published dev secrets are accepted on the public compose profiles.**
   - The refusal signal (`REGULAIT_HSTS`) is never forwarded to the gateway container.
   - So `tls`, `hosted` and `tunnel` boot with a known full-admin bootstrap token and a known data key (S-02).
6. **PM inbound webhooks have no replay protection on any provider.**
   - No timestamp window and no delivery-id dedup.
   - Jira and monday rely on static URL tokens.
   - The generic adapter accepts a static header (S-03).
7. **Process cost is now the main drag on throughput.**
   - Over 3 weeks: 699 merge commits against 885 content commits.
   - The migration journal took 115 commits and 37 recorded conflicts, with 20 renumber commits.
   - A review finding on #605 was missed across three rounds because findings have no tracked state (R-01 to R-03).
8. **Open source first is behind its own deadline.**
   - Three ADR-0176 "Replace" items are still open after 11-03.
   - `apps/gateway/THIRD_PARTY.md` lacks rows for 25 production deps; `apps/web` lacks 3.
   - No check compares the rows to `package.json` (O-01, O-02).
9. **Code health is acceptable but concentrated.**
   - `schema.ts` (15,630 lines) and `app.ts` (6,445 lines, 72 routes, no service layer) are the churn hot spots.
   - The web app hand-copies about 2,150 lines of gateway types (C-01, C-02).
   - Tests do check behaviour: real routes and DB, no snapshots.
10. **For an enterprise pilot**, the top blockers, in order:
    - no production-grade or BYOC deployment path;
    - the three security defaults above;
    - governance coverage beyond MCP;
    - integration lifecycle (disable, rotate);
    - release signing.

---

## Findings

Severity follows the CLAUDE.md convention: a confirmed security-checklist gap is a blocking bug under ADR-0180.

### Security (ADR-0200 checklist and ADR-0180 secure by default)

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| S-01 | **high** | **RLS covers 4 of 338 tables and is enforced on none at runtime.**<br>• Only migration 0272 enables RLS, with ENABLE + FORCE and policies on users, auth_mfa_pending, approvals and audit_log.<br>• ADR-0234 is still Proposed, and batches 2–7 are not built.<br>• Non-test gateway code never calls `withPrincipal` or `withSystemContext`.<br>• One `pg.Pool` built from `DATABASE_URL` serves both migrations and requests. The shipped login is the image superuser, which bypasses FORCE.<br>• No boot check refuses a `rolsuper` or `rolbypassrls` login. | `packages/db/migrations/0272_rls_foundation_slice1.sql:131-133,159-161,181-183,288-290`<br>`internal/decisions/0234-postgres-row-level-security.md:3,13-15,190-196`<br>`packages/db/src/rls.ts:19-21,120-160`<br>`apps/gateway/src/main.ts:11-38`<br>`packages/db/src/index.ts:347-357`<br>`docker-compose.yml:116,341`<br>`scripts/install.sh:916`<br>`boot.ts`: no role check | Do batch 7 (a non-owner runtime login and a boot refusal of superuser or BYPASSRLS) together with batch 2 (wrap request handling in `withPrincipal`) as the next security batch. Then roll out table batches in order: user-owned, then credentials, then project. Track every remaining batch as a blocking bug. Update the ADR-0234 inventory: it says 329 tables, and there are now 338. |
| S-02 | **high** | **Published dev secrets are accepted unless the operator sets a deploy signal, and the public profiles never set one.**<br>• `assessDevSecrets` refuses the published bootstrap token or data key only when `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` is set.<br>• Compose falls back to the published values, and `DEPLOY_MODE` defaults to empty.<br>• The base compose never forwards `REGULAIT_HSTS` to the gateway (only install.sh's override adds it), so `--profile tls`, `hosted` and `tunnel` boot with both published values.<br>• The bootstrap credential is a full admin with no expiry. It skips MFA and the IP envelope, and keeps working after a real admin exists.<br>• Step-up actions are refused once an admin has a step-up method, but the bootstrap credential can still mint an API key for any user, including a TOTP-enrolled admin, without step-up.<br>• Mitigation: the no-profile stack publishes the gateway on loopback only. | `apps/gateway/src/dev-secrets.ts:35-36,60-66,97-103`<br>`apps/gateway/src/boot.ts:197-205,430-441`<br>`docker-compose.yml:351-352,411`<br>`apps/gateway/src/auth.ts:248-249`<br>contrast `metrics.ts:420-447` (strict refusal) | Refuse published values unless the bind is loopback or an explicit dev opt-in is set. Treat an `https` non-loopback `REGULAIT_PUBLIC_URL` as a deploy signal. Forward `REGULAIT_HSTS` in the base compose. Retire the bootstrap credential automatically once an active admin exists. Make API-key minting for another user a step-up action. |
| S-03 | **high** | **PM inbound webhooks have no replay protection on any provider path.**<br>• No parser checks a timestamp. `pm_sync_events` is a plain append with no unique key, so a replayed delivery is fully re-processed: it can re-orphan links, re-flag drift and re-trigger `prefer_regulait` pushes.<br>• Jira and monday authenticate with a static `?token=`. Azure DevOps uses a static basic-auth password and ignores the username.<br>• The generic adapter falls back to a static `x-regulait-webhook-secret` when no signature header is sent.<br>• `pm.ts` falls back to a legacy hash compare whenever `dataKey` is unset.<br>• Even the HMAC paths (Linear, Asana) sign only the body.<br>• No ADR records an exception. Contrast: Slack ChatOps enforces 300 s. | `packages/pm-provider/src/inbound.ts:72-93,160-161,240,328,395-396,501-511,596-610`<br>`apps/gateway/src/pm.ts:862-872,1060-1073`<br>contrast `packages/shared/src/chatops.ts` (Slack window) | Add a `pm_webhook_deliveries` table with a unique key on (integration, delivery id), or on a body hash where the provider gives no id. Enforce Linear's signed timestamp within a window. Remove the generic static-header path and the legacy hash fallback: ADR-0180 forbids grandfathering. Document URL-token rotation for Jira and monday. |
| S-04 | medium | **Grant-minting routes have no step-up, while smaller relaxations do.**<br>• Eight routes widen default-deny with only the SoD check and `admin_only`: person and role grants of tools, servers, agents and connectors.<br>• Adding an egress host, lifting a revocation and replacing a workload-identity grant set do need step-up.<br>• Admin API keys can never step up, so a leaked admin key can widen anyone's access. | `apps/gateway/src/app.ts:2581,2612,2675,2696,2718,2737`<br>`apps/gateway/src/agents-connectors.ts:3757,5327`<br>contrast `custom-providers.ts:309-361`, `app.ts:3120,3184,3236`, `workload-identity-admin.ts:649`, `step-up.ts:35-38` | Add a `grant_mint` step-up kind, or reuse `settings_relax`, on all eight routes. The DELETE routes correctly need none. |
| S-05 | medium | **A2A calls bypass the policy kernel entirely.** `a2a.ts` imports nothing from `policy-kernel`, so the kill switch (`executionGate`), the read-only and halted modes and the AI-literacy gate do not apply. Mitigation: `a2aEnabled` is off by default. | `apps/gateway/src/a2a.ts` (no kernel import)<br>`packages/policy-kernel/src/index.ts:1541-1546` (gate on other paths) | Route A2A through the same kernel evaluation, or at minimum through `executionGate`, before A2A can be switched on in any pilot. |
| S-06 | medium | **Connector and A2A calls with no project run unattributed and skip the budget gate.** This is a loose default under ADR-0180. MCP and compat each require attribution by default; agent dispatch has `dispatchAttributionRequired`; connector and A2A have neither. | `apps/gateway/src/connector-call.ts:365,406`<br>`apps/gateway/src/projects.ts:796` (`preDispatchProjectGate` returns ok on a null project)<br>`use-case-gate.ts:111-119` (called only from `agents-connectors.ts:1530`)<br>`a2a.ts:307` | Extend the attribution mandate to connector and A2A calls, default on. |
| S-07 | medium | **Authentication runs after body parsing.** The auth hook is a `preHandler`, so unauthenticated callers get bodies of up to about 11 MiB parsed on raised-`bodyLimit` routes. Only the supplier upload checks the credential first. CPU cost was not measured (UNVERIFIED). | `apps/gateway/src/app.ts:1178`<br>`bom-routes.ts:376`, `decision-receipts.ts:387`, `cost-import.ts:383`, `endpoint-import-routes.ts:149`, `shadow-ai.ts:667`<br>contrast `supplier-portal.ts:1108-1118` | Add an `onRequest` credential pre-check, at least on every route with a raised `bodyLimit`. |
| S-08 | low | Password hashing uses scrypt N=2^14, r=8 (16 MiB), below the commonly cited N≥2^17. `scryptSync` blocks the event loop on every login. | `apps/gateway/src/auth.ts:445-448,452,468,484` | Raise the parameters with rehash-on-login, or move to a maintained Argon2id module. Use async scrypt. |
| S-09 | low | Any `Authorization: Bearer x` header moves pre-auth traffic from the 1,200/min tier to the 6,000/min tier per IP. | `apps/gateway/src/rate-limit.ts:237-251,285` | Apply the higher tier only after the credential has been verified. |
| S-10 | low | Hardening items:<br>• `isAdmin = opts.isAdmin ?? true` (latent, since both callers pass it);<br>• CSP keeps `style-src 'unsafe-inline'`;<br>• the Teams interaction path has `replayWindowEnforced: false`;<br>• `sql.raw` builds `ARRAY[...]` literals, safe today only because of `assertUuid`. | `reporting.ts:575`<br>`security-headers.ts` (`documentCsp`)<br>`packages/shared/src/chatops.ts:155-158`<br>`reporting.ts:257`, `compliance-packs.ts:169`, `copilot.ts:439` | Make `isAdmin` required. Use style hashes or nonces. Deduplicate Teams activity IDs. Use `inArray` or `= ANY($1)`. |

**What's solid.**
- Route authorization is default-deny from one source (`route-classes.ts`). A scan of 156 non-admin parameterised routes found no missing object-level check.
- MFA is required for admins, step-up is strict by default, and CSRF requires both SameSite=Strict and a custom header.
- The DNS-pinned guarded fetch covers about 23 outbound sites, with no stray raw fetch to user-supplied URLs found.
- `jose` pins the JWT algorithm and audience.
- The web app keeps no tokens in browser storage, ships no source maps and has no `dangerouslySetInnerHTML`.
- Pino redacts sensitive fields.
- `pnpm audit --prod` reported 0 advisories across 576 production dependencies.

### Pillar fit

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| P-01 | **high** | **Pillar 1 is uniform only for MCP.**<br>• Kernel approval rules, rate limits and ABAC are fields on the tool `EvaluationInput` only.<br>• For agent and connector calls, ABAC is "never supplied on this path today", and the model decision is allow or deny only (the dial's `require_approval` maps to deny).<br>• Model rate limits exist but are off by default.<br>• Connectors have no governance rate limit, only the generic HTTP limiter, which does not cover in-process builder-tool calls.<br>• Connector writes get an approval hold only under the execution dial, with no approval rules.<br>• ARCHITECTURE.md:118-148 says all call types go through `governedEvaluate`. That function is called only from the MCP surfaces and the simulation and evaluate callers. | `packages/policy-kernel/src/index.ts:586-587,631,1503,1514-1519,1541-1546,1780`<br>`internal/ARCHITECTURE.md:61,118-148`<br>`apps/gateway/src/governed-evaluate.ts:283-305`<br>`schema.ts:1908-1933,4386`<br>ADR-0040 §7.1, ADR-0212 | Write an ADR that brings model, connector and A2A calls under one `governedEvaluate` core, covering approval rules, rate windows and ABAC per resource type. Until it lands, correct ARCHITECTURE.md and every buyer-facing claim of "approvals and rate limits on every call". |
| P-02 | **high** | **The plan-only gate is opt-in.**<br>• On `/v1/agents/:id/invoke` the gate runs only inside `if (body.instanceId)`.<br>• A regression test pins that `execute` with `dispatch:true` and no `instanceId` returns 200 while the instance is in planning.<br>• The compat shims hard-code `COMPAT_MODE = "execute"` and the MCP proxy has no instance join point, so both ignore planning entirely.<br>• `/v1/runs` follows the same opt-in pattern.<br>• ADR-0079 discloses this as a limit, but it conflicts with ADR-0180 and with the "forced Plan-only" pillar text. | `apps/gateway/src/agents-connectors.ts:4001-4016`<br>`apps/gateway/src/plan-only.ts:136-220`<br>`apps/gateway/src/plan-only.test.ts:305-320`<br>`apps/gateway/src/compat-core.ts:129`<br>`packages/shared/src/index.ts:1326-1339`<br>ADR-0079 (Honest limits) | Enforce at project level: refuse non-plan-safe modes on every surface while any instance of the target project or repo sits in a planning stage. Make instance attribution mandatory where a project has active instances. ADR-0079 line 168 is also out of date: conversation turns do pass the gate when they name an instance. |
| P-03 | medium | **In pillar 3, "BYOC" means one compose stack on the customer's host.**<br>• `infra/modules` holds nothing for deploying into a customer's own AWS, Azure or GCP account.<br>• The infra and deploy adapters answer 501 unless a live flag is set, and ROADMAP records them as never run against a real cloud.<br>• The compliance cascade and the air-gap egress posture are real and enforced. | `internal/ARCHITECTURE.md:228-236`<br>`packages/infra-provider/src/index.ts:410-472`<br>`apps/gateway/src/infra.ts:310-372`<br>`internal/product/ROADMAP.md:200-206`<br>`projects.ts:368-400`<br>`deploy-posture.ts:88-136` | Run one live sandbox check per cloud for the infra and deploy adapters. Add reference BYOC packaging (Terraform or Helm) to `infra/modules`. Disclose the difference in buyer docs until then. Whether packaging exists outside this repo is UNVERIFIED. |
| P-04 | medium | **Pillar 8 adapters are real HTTP clients, proven only against fake servers.**<br>• Covered: Azure DevOps, Jira, Linear, Asana, monday and a generic adapter.<br>• The ADR-0054 work-item importer is not built.<br>• Inbound description, priority and acceptance-criteria fields are only stored in the event payload. Only state changes and deletes affect RegulAIt, so the PM tool is not yet the source of truth that the pillar promises. | `packages/pm-provider/src/index.ts:330,453,584,746,873,1079`<br>`apps/gateway/src/pm.ts:862-872,912-1000`<br>`internal/product/PENDING.md` ("Blocked on a live instrument")<br>ADR-0054 | Do a live sandbox pass for Jira and Azure DevOps first. Build the importer and adopt inbound fields. |
| P-05 | medium | **Orchestration "parallel" waves run one after another.** Auto-advance awaits each wave node in turn, so pillar 7's "run independent subtasks in parallel" holds only in the recorded state. | `apps/gateway/src/orchestration.ts:2607-2614,2771-2820` | Dispatch each wave concurrently with a bound, using the existing atomic `chargeRunEstimate`, or state plainly that execution is sequential. |
| P-06 | medium | **Batching savings are estimates, but they are counted as realised.** Batching writes tokens-saved rows that the savings totals include, and the UI says batching "works on your behalf". | `orchestration.ts:2710-2760`<br>`optimization.ts:40-46`<br>`projects.ts:2586-2594`<br>`apps/web/.../SpendPage.tsx:561`, `OptimizationPage.tsx:119` | Exclude batching estimates from realised savings and show them as "opportunity". |
| P-07 | low | **Pillar 6 is thin on the IDE path.** Compat calls get only routing and the semantic cache, and the cache is off by default. | `apps/gateway/src/compat-core.ts:62,860`<br>`schema.ts:4148-4159,4175` | Apply compaction and dedup to compat calls, or document the gap. |
| P-08 | low | **Pillar 4: shared context reaches only orchestration run nodes.** Plain agent invokes and IDE calls never see it. | `apps/gateway/src/orchestration.ts:526-549` | Inject project context on governed invoke when a `projectId` is attributed. |
| P-09 | low | **Several docs contradict the code or each other.**<br>• The `workflow-kernel` header comment says deployment and rollback stages are rejected; they are supported.<br>• PENDING §1 says "No LLM provider is connected", against its own addendum.<br>• Only the Google model adapter has been checked live (August). | `packages/workflow-kernel/src/index.ts:10-13`<br>`internal/product/PENDING.md` §1 | Fix the comment and PENDING §1. Add live smoke checks for the other model providers. |

### Architecture, code health, tests and migrations

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| C-01 | medium | **The web app hand-copies the gateway contract.**<br>• `apps/web` depends on neither `@regulait/shared` nor `@regulait/api-client`.<br>• `api/types.ts` (1,199 lines) and `adminTypes.ts` (948 lines) are written by hand.<br>• 42 "mirrors …" comments mark copied rules.<br>• About 36 tests read gateway source text to catch drift. | `apps/web/src/api/types.ts`, `adminTypes.ts`<br>e.g. `apps/web/src/api/step-up-refusal.test.ts:109` | Generate web types from the gateway OpenAPI (`openapi-client-gen.ts` already exists), or export a browser-safe slice of `shared`. |
| C-02 | medium | **A few god files take most of the churn.**<br>• `packages/db/src/schema.ts`: 15,630 lines, 256 commits.<br>• `apps/gateway/src/app.ts`: 6,445 lines, 72 routes, 57 direct DB calls, no service layer, 253 commits.<br>• `packages/shared/src/index.ts`: 4,869 lines, 213 exports, 239 commits.<br>• 18 non-test gateway files are over 2,000 lines.<br>• The gateway import-cycle baseline (74 edges) has not shrunk since 10-16. org-settings and mcp-proxy are each on 8 edges.<br>• Package boundaries are clean: no package cycles and no `@regulait/*/src` deep imports. | `wc -l`<br>`git log --oneline -- <file> \| wc -l`<br>`scripts/import-cycles-gateway.baseline.txt` | After the freeze, split `schema.ts` and `app.ts` by domain. This also removes most merge conflicts on them. Ratchet the cycle baseline down. |
| C-03 | medium | **The migration guard leaves gaps.**<br>• `migration-watermark-guard.mjs` reads only the journal and skips tags already on base. It cannot see edits to a merged migration's SQL, removal of a merged entry, or `idx` and breakpoint changes. It has no journal-to-`.sql` 1:1 check (both are 230 today).<br>• It does catch a broken `when` order and a renamed merged tag.<br>• 51 numbers are missing across 14 gaps.<br>• A `drizzle-kit generate` script is still exposed, against a stale `0000_snapshot.json`.<br>• No schema-to-SQL parity test was found (UNVERIFIED that none exists). | `scripts/migration-watermark-guard.mjs:13,18-29,39-40`<br>`scripts/migration-watermark-guard.test.mjs:18-20`<br>`.github/workflows/ci.yml:285-294`<br>`packages/db/package.json` (`generate`) | Extend the guard: merged entries and their `.sql` bytes are unchanged, and the file set equals the journal. Remove the `generate` script. Add a parity test (fresh migrate compared with schema introspection). See R-03 for the structural fix. |
| C-04 | medium | **The route-census test pins set sizes**: `MACHINE_ONLY` 46, `SUPERSEDED` 16, `INDIRECT_UI_CALLS` 55 and `KNOWN_UI_GAPS_MAX` 0. Every new route edits the same lines, so this is a merge hot spot rather than a flaky test: 27 commits in 3 weeks, 13 of them merges of main, and at least 7 conflicts on open PRs on the night of 11-06. | `scripts/preflight-ui-route-census.test.mjs:355-363` | Drop the three count pins (the owner approved dropping `INDIRECT`). The per-entry reason and stale-entry checks already enforce intent. Keep `KNOWN_UI_GAPS_MAX = 0`. |
| C-05 | low | **Test isolation has gaps.**<br>• The gateway suite runs files serially per CI shard, each shard on a fresh Postgres.<br>• The 177 `zz-` file prefixes do nothing for gateway order: vitest orders by size and cache, and CI by SHA-1 of path. The prefixes are a leftover of the Playwright rule M-018.<br>• Hidden cross-file state dependencies (for example on the `org_settings` singleton) are masked rather than prevented.<br>• 390 of 522 files repeat the migrate and `DATABASE_URL` bootstrap.<br>• There is one placeholder `expect(1).toBe(1)`. | `apps/gateway/vitest.config.ts:5-7`<br>`vitest.run-last.config.ts:6-14`<br>`ci.yml:352-362`<br>e.g. `zz-adr0180-assurance-foundation.test.ts:87`<br>`scripts/preflight-egress-allow-cleanup.test.mjs:88` | Use a shared bootstrap helper. Give files that touch singletons a scratch schema (`testing/scratch-db.ts` exists). Stop adding `zz-` prefixes to gateway tests, and replace the placeholder assertion. |
| C-06 | low | **Flaky-test hot spots.**<br>• The real garak suite never runs in CI: it is skipped unless `REGULAIT_GARAK_PYTHON` is set, and no workflow sets it.<br>• The token-endpoint timeout test races a 150 ms timer against a 600 ms hook and polls for 5 s, so it depends on wall-clock timing.<br>• The intermittent "work is BOUNDED" rescan failure on #605 traces to the open finding in R-02, not to the test. This applies to the #605 branch, not `main` (UNVERIFIED here). | `packages/engine-garak/src/garak-real.test.ts:72`<br>`apps/gateway/src/zz-adr0188-s5-token-endpoint.test.ts:1028` | Run the real garak suite nightly. Use fake timers in the timeout test. |
| C-07 | low | **Dead or unchecked code.** `apps/web/review/` (21 files, 2,576 lines) imports `packages/*/dist` and sits outside the web tsconfig, so nothing type-checks it. `spikes/` holds 106 files (about 23k lines). | `apps/web/review/`<br>`spikes/` | Move both under `internal/` or delete them. |

### Open source first (ADR-0176)

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| O-01 | medium | **`THIRD_PARTY.md` is incomplete.**<br>• `apps/gateway/THIRD_PARTY.md` has rows for 23 of 48 non-workspace production deps. The 25 missing:<br>  – `@aws-sdk/client-{acm,backup,ecs,s3,ssm,sts}`;<br>  – `@azure/{arm-compute,arm-recoveryservicesbackup,arm-resourcegraph,arm-resources,identity,keyvault-certificates}`;<br>  – `@fastify/rate-limit`;<br>  – `@google-cloud/{backupdr,certificate-manager,config,os-config}`;<br>  – `@kubernetes/client-node`, `@modelcontextprotocol/sdk`, `@node-saml/node-saml`;<br>  – `ajv`, `ajv-formats`, `fastify`, `openid-client`, `zod`.<br>• `apps/web/THIRD_PARTY.md` lacks `react`, `react-dom` and `@tanstack/react-query`.<br>• `xml-crypto` is an exact-pinned gateway devDependency (tests only), and transitive through node-saml in the shipped closure.<br>• `packages/db/THIRD_PARTY.md:12` says drizzle-kit is exact 0.31.11; `package.json` has `^0.31.4`.<br>• No preflight compares rows to `package.json`. The licence gate does cover the whole `--prod` closure. | `apps/gateway/package.json:30-95,104`<br>`apps/gateway/THIRD_PARTY.md:7-32`<br>`apps/web/package.json:16-28`<br>`apps/web/THIRD_PARTY.md:7-16`<br>`pnpm-lock.yaml:248-250,5279-5290` | Add the rows. Add a preflight that fails when a production dep in any workspace has no row, and when a row's stated pin does not match the manifest. |
| O-02 | medium | **Three ADR-0176 "Replace" decisions are open past the 11-03 deadline:**<br>• `upstream-retry.ts` (429 lines; cockatiel planned);<br>• `shared/tracing.ts` OTLP encoder (960 lines; `@opentelemetry/otlp-transformer` planned);<br>• `scheduler.ts` (924 lines; pg-boss or graphile-worker planned).<br>None of the target libraries is in any manifest. | `internal/decisions/0176-open-source-first.md:226-229` | Schedule one replacement batch per item, keeping the existing tests. |
| O-03 | medium | **Hand-written CSV and canonical-JSON code exists next to the libraries.**<br>• Two CSV parsers: `onboarding.ts:610`, whose comment claims there is "exactly ONE CSV parser", and `reporting.ts:737`.<br>• A CSV writer: `billing.ts:494`.<br>• Meanwhile `csv-parse` and `csv-stringify` are already dependencies.<br>• `stableStringify` copies remain, while `canonicalize` is a shared dependency. | `packages/shared/src/onboarding.ts:610`, `reporting.ts:737`<br>`apps/gateway/src/billing.ts:494`, `fairness.ts:45`, `reporting.ts:36`<br>`config-versions.ts:987`, `mcp-admission.ts:431` | Switch to `csv-parse` (its `info` option gives line numbers), `csv-stringify` and `canonicalize`. |
| O-04 | medium | **Two JSON-Schema validators can disagree.** The eval scorer uses a hand-written subset validator; the playground uses full Ajv. The same schema can pass in an eval and fail in the playground. | `packages/shared/src/evals.ts:589,723`<br>`apps/gateway/src/playground.ts:100-125` | Use the shared Ajv + re2js instance in evals. |
| O-05 | low | **The licence rule's wording conflicts with an accepted exception.** The engine images ship libgfortran (GPL-3.0 with the GCC runtime exception) and libquadmath (LGPL-2.1), which the owner accepted under ADR-0187. On its face, the CLAUDE.md rule "no GPL … in shipped code" forbids this. Note: the torch entry's "BSL-1.0" is the Boost licence, not the Business Source Licence. | ADR-0187 (decisions 106, 193)<br>CLAUDE.md "open source first" §3 | Write the runtime-exception carve-out into ADR-0176 so the rule and the practice agree. |

### Process

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| R-01 | **high** | **A review is a prose comment, not a GitHub review.** Every session posts as the owner account, so there is no review state, no thread resolution and nothing branch protection can enforce. | PR #605: `get_reviews` returns `[]`; all 14 comments have association OWNER | Run reviewer sessions under a separate GitHub App identity that submits real reviews with inline threads. Turn on "require conversation resolution" and "dismiss stale approvals". The merge loop refuses a head with any unresolved thread. |
| R-02 | **high** | **#605: a verified one-line fix was missed across three review rounds.**<br>• The fix: the rescan query lacks `isNull(mcpServers.disabledAt)`, so disabled servers use up capped batch slots.<br>• Raised at ee3d71b6, and still open at 3c30ced9 and at 78414e79.<br>• Every push after round 2 reacted to `main` moving (journal merges, renumbers, an entry-trim merge).<br>• The lane's status posts on #453 at 00:13, 00:48, 03:00 and 03:24 never list the finding.<br>• `READY` meant "CI green", not "findings closed", and the security verdict said APPROVE while the code verdict said REQUEST CHANGES. | PR #605 review comments (11-06 22:05 and later)<br>#453 comment 6702033079 | Number every finding. A `READY` post lists each open finding with the commit that fixes it, or "deferred, accepted by". Every delta review opens with the previous round's open findings. Reviewers post one-line fixes as GitHub suggestion blocks. |
| R-03 | **high** | **The migration journal serialises unrelated PRs.**<br>• In 3 weeks the journal took 115 commits (66 of them merges of main), with 37 recorded conflicts and 20 renumber or re-stamp commits.<br>• #605's migration was renumbered three times (0219→0262→0277→0285), and #628's three times.<br>• Each landing forces the next PR to merge main and re-run CI, for example #683 waiting on #605. | `git log -- packages/db/migrations/meta/_journal.json`<br>#453 comments 6697259161, 6701062213 | Structural fix: lanes write a placeholder migration (`pending_<branch>.sql`) and no journal entry. A merge-queue step assigns the next number and `when`, then appends the journal entry on the merge-group ref. Or use a migrator that tracks which migrations have run, not a watermark, and fails loudly on any unapplied migration below the highest one applied. Either way, nobody edits the journal on a branch. |
| R-04 | medium | **A script that resolved census-test conflicts silently deleted a guard assertion** on four PRs (`expect(SUPERSEDED.size)` on #639, #640, #681 and #692). It was restored later. | #453 designer comment, 11-07 03:00 | Never resolve test files by script. Add a CI check that each guard-test file's assertion count is not below the base branch's. C-04 removes the main source of these conflicts. |
| R-05 | medium | **Unrelated commits get folded into approved PRs.**<br>• The entry-trim commit aae03518 was merged into #605, #622, #654, #681, #690 and #691.<br>• #605 grew from a UI prototype into 39 files and 3,187 lines, with migrations and an ADR, while still titled "HOLD proto… needs API". | #453 master comment, 11-07 00:56<br>PR #605 file list | A cross-cutting fix gets its own PR, and others merge `main` once it lands. Re-review any PR whose diff leaves its declared surface, and refresh its title and body. |
| R-06 | medium | **Each PR passed the size limit alone, and the combined tree did not.** `main` itself was over the entry-JS limit at 6a06dc1 (139,555 B against 139,500 B). This repeats M-104. | #453, 11-07 03:24 (not re-run here: UNVERIFIED) | Use GitHub merge queue, running size-limit and the full gate on the merge-group ref. Log the repeat in `mistakes.md`. |
| R-07 | medium | **The memory files have drifted.**<br>• STATE.md is 495 KB and 5,828 lines; its recap and `last_updated` say 10-29.<br>• The last session file is from 10-25, and there is no record of the demo's outcome.<br>• The PENDING header says "current as of 2026-08-03".<br>• `mistakes.md` stops at M-108 (10-31), with no entries for the #605 miss, the census-guard deletion or the M-104 repeat.<br>• The ADR index (448 KB) took 165 commits and 34 conflicts in 3 weeks. | `internal/memory/STATE.md:1-9`<br>`internal/memory/sessions/`<br>`internal/product/PENDING.md` header<br>`internal/decisions/README.md` | Generate the ADR index from ADR front matter in CI, and stop editing it by hand. Write STATE.md's recap as per-session fragment files compiled by a script (a towncrier-style pattern). Set `merge=union` in `.gitattributes` only for line-append logs, never for the journal JSON. Log the three missed mistakes. |
| R-08 | medium | **Coordination is too centralised.**<br>• Everything runs through one issue (#453, over 360 comments), and master's broadcasts mix many PRs per comment.<br>• One lane holds about 20 PRs and 3 background builders.<br>• About 70 CI runs were queued at once (11-06 21:47), and reviews were done at heads with CI still queued.<br>• Over 3 weeks, `main` took 699 merges against 885 content commits: about 2 merges of main per PR. | #453<br>`git log origin/main --merges` | Cap open PRs per lane (for example, 5 or fewer). Keep each PR's status in that PR as a checklist a script updates, and use #453 only for decisions. A merge queue batches merges, which cuts both the merge-main loop and the CI backlog. |

---

## Product readiness: what blocks an enterprise pilot (ranked)

1. **There is no production-grade or customer-cloud deployment path.**
   - The original AWS Organization is gone (ADR-0203).
   - Hosting is a single hardened instance (ADR-0228), and high availability is deferred (PENDING P2).
   - "BYOC" is one compose stack (P-03).
   - Nothing holds a production designation, which needs the owner's explicit sign-off under the standing guardrail.
2. **Three security defaults would fail a buyer's security review on day one:** S-01 (RLS), S-02 (published secrets on the public profiles) and S-03 (webhook replay). All three are blocking bugs under CLAUDE.md.
3. **Governance coverage is weaker than the pitch.** Approvals, rate limits and ABAC cover MCP calls only, and the plan gate is opt-in (P-01, P-02, S-05, S-06). This is the core value proposition, and buyers will test it first.
4. **Integration lifecycle basics are missing on `main`.**
   - There is no per-server or per-connector disable or delete route. `updateServerSchema` has no disable field, and no DELETE route exists for servers or connectors.
   - There is no webhook-secret rotation route.
   - Git-token replacement is held in #604 and #605.
   - So an admin cannot cleanly cut off one MCP server they suspect is compromised. Whether grant revocation or the org kill switch covers every caller is UNVERIFIED.
5. **There is no real release keypair.** The update-bundle and licence verifiers pin a dev public key whose private half was not kept (PENDING S3, `infra/release-keys/`). Customers cannot verify updates or licences.
6. **Integrations are not live-proven.** Only the Google model adapter was checked live. The PM adapters have run against fake servers only, and the infra and deploy adapters have never run live (P-03, P-04, P-09).
7. **The docs are not buyer-ready.** STATE, PENDING and ROADMAP are stale (R-07), there is no admin guide, and ARCHITECTURE.md overstates the decision core (P-01).

---

## Top 10 next actions (prioritised)

1. **S-02 (small, high leverage).** Refuse published dev secrets unless the bind is loopback or an explicit dev opt-in is set. Treat an https `PUBLIC_URL` as a deploy signal and forward `REGULAIT_HSTS`. Retire the bootstrap credential once a real admin exists.
2. **S-03.** Add a webhook delivery dedup table and timestamp windows, and remove the static-header and legacy-hash fallbacks.
3. **S-01.** Run ADR-0234 batches 7 and 2 together: a non-owner runtime role, a boot refusal of superuser or BYPASSRLS, and `withPrincipal` around requests. Then roll out the table batches as blocking work.
4. **R-03 and C-04 (structural conflict fixes, one small PR).**
   - Drop the census count pins.
   - Move migration numbering and journal append to a merge-queue step, and turn on GitHub merge queue (which also fixes R-06 and part of R-08).
   - Extend the watermark guard (C-03).
5. **R-01 and R-02.**
   - Reviewer sessions post real reviews under a separate App identity.
   - Require conversation resolution.
   - Number every finding.
   - `READY` lists each finding with its fixing commit.
6. **P-02.** Enforce plan-only at project level on every surface: invoke, runs, compat and MCP.
7. **P-01, S-05 and S-06.** Write an ADR for one `governedEvaluate` core covering model, connector and A2A calls, with the attribution mandate on by default. Correct ARCHITECTURE.md now.
8. **S-04.** Make the eight grant-mint routes a step-up action.
9. **Readiness item 4.** Merge per-server and per-connector disable, credential and webhook-secret rotation, and git-token replacement as one small "integration lifecycle" batch, split out of #604 and #605.
10. **O-01, then O-02 and O-03.** Add the missing THIRD_PARTY rows plus a preflight that keeps them complete, then schedule the three overdue ADR-0176 replacements.

After those: generate the ADR index and compile STATE from per-session fragments (R-07). Run live sandbox passes for Jira and Azure DevOps and for one cloud's infra adapter (P-03, P-04). Run the key ceremony for a real release keypair (readiness item 5).

---

*Evidence line numbers are at 6a06dc1. Process counts come from git history between 2026-10-17 and 2026-11-07, and from issue #453 and PR #605 as read on 2026-11-07. Items marked UNVERIFIED were reported by a review pass but not independently re-read in code.*
