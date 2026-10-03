# RegulAIt — full product review record, 2026-10-02

Reviewed tree: `dhruv/active` @ `0617ace` (read-only; no file under the repo was edited by any finder or verifier).
Inputs: `scratchpad/review-results.json`, `scratchpad/batches.json`, ADR-0167, commit `22e83e7` (branch `wt-deps`).

## 1. Scope and method

Nine independent finders, one per area, each working from source plus live probes (built gateway on a throwaway
Postgres, Playwright against the demo gateway, `pnpm audit`). Every finding then went to a separate verifier that
re-derived it from source or re-ran the probe. Security areas were verified twice, under two adversarial lenses
(**exploitability** and **impact**); reliability and UI areas once (**reproducibility**). A finding is *confirmed*
when no lens refuted it; *downgraded* when a lens confirmed it at a lower severity; *refuted* when a lens showed it
does not hold. Verifiers also reported what the finder *missed* (§5), which nobody has verified.

| Area | What it covered | Lenses | Findings | Confirmed | Downgraded | Refuted |
|---|---|---|---|---|---|---|
| sec-authz | route auth classes, object-level authz on ~110 handlers, sessions, SSO, SCIM, CSRF, rate limiting | 2 | 11 | 10 | 1 | 0 |
| sec-input | SQL, egress guard and every fetch consumer, secrets custody, imports/exports, SPA sinks, `pnpm audit` | 2 | 10 | 7 | 3 | 0 |
| sec-config | Dockerfile/compose/Caddy/install.sh, boot sequence, global hooks, headers/CSP, crypto, per-advisory reachability | 2 | 15 | 11 | 4 | 0 |
| rel-backend | boot, pool, scheduler, transactions and locks, retries/deadlines, streaming, pagination, migrations | 1 | 15 | 11 | 4 | 0 |
| rel-tests | shuffled full gateway run, CI workflows and run history, e2e configs, operator docs vs scripts, demo scripts | 1 | 17 | 12 | 4 | 1 |
| ui-admin-a | 32 admin pages as Ada, light+dark, 1366 and 390 px, forms, keyboard, link audit | 1 | 24 | 17 | 7 | 0 |
| ui-admin-b | 35 admin pages as a fresh admin, light+dark, heading audit, confirm modals, header spot checks | 1 | 21 | 14 | 3 | 4 |
| ui-workspace | 17 workspace pages as Dana/Avery/new user, login and forced-password gates, mobile, server probes | 1 | 18 | 16 | 2 | 0 |
| ux | seven end-to-end journeys (first run, member, intake, approver, monitor, failure modes, 84-route sweep) | 1 | 19 | 13 | 5 | 1 |
| **Total** | | | **150** | **111** | **33** | **6** |

Refuted (dropped): OPS-05, UIB-08, UIB-16, UIB-18, UIB-21, UXJ-19. The 144 not refuted were grouped into four fix
batches (security 16, reliability 19, ui-blockers 2, ui-polish 18 = 55) and 89 deferred low-severity items (§3).
Finder severities above are pre-verification; the tables in §3 carry the post-verification severity.

## 2. What is sound

Deduplicated from the nine finders' strength reports; stated for a security buyer.

- **One source of truth for access.** A single file defines which routes are public, user-level or admin-only; the admin
  gate is default-deny, an unknown route still answers 401, and the OpenAPI document is derived from the same objects so
  docs cannot drift from enforcement. Object-level checks (owner, project role, initiator-or-approver) are consistently
  present; non-participants get 404 where existence would be a disclosure.
- **Separation of duties in one place.** All approvals pass one decide path keyed on the actual decider, so bulk, chat and
  delegation routes cannot approve their own override, grant or remediation; overrides and self-reviews need a recorded
  reason and are audit-stamped. Admin rights cannot be obtained via SCIM, SSO provisioning, group mappings, virtual keys
  or user PATCH. Deactivation, password change and demotion take effect on the next request, live sessions included.
- **Sign-in and sessions.** HttpOnly, SameSite=Strict, Secure cookies with absolute and idle expiry; a custom header on
  every cookie-authenticated mutation (CSRF); OIDC with PKCE, nonce and single-use state; SAML with pinned issuer and
  recipient, InResponseTo, unsolicited assertions refused, replay blocked by a unique index; uniform login failure (no
  account oracle); per-account lockout; constant-time comparisons.
- **Secrets.** API, session, virtual and SCIM tokens stored only as SHA-256; passwords as salted scrypt; stored
  credentials under AES-256-GCM envelope encryption with per-record IV and key fingerprint; boot refuses on a wrong or
  missing key after a real ciphertext probe; resumable re-encryption; read projections strip ciphertext structurally.
- **Network boundary.** One default-deny egress guard for every outbound call: exact-host allow-list, userinfo refused,
  private ranges / IMDS / IPv4-mapped / NAT64 / CGNAT blocked, DNS resolved then pinned, redirects refused, re-checked
  per request; every admin-typed URL routes through it (SEC-01 was the exception). Proxy trust defaults to nothing, so
  client IPs in the audit trail cannot be forged. Database and object store publish no ports.
- **Input and browser.** No dynamic SQL identifiers (drizzle advisory not exploitable); all validation is zod; strict CSP
  with boot-hashed inline scripts, frame-ancestors none, nosniff, COOP/CORP; locked-down CSP on API responses; no CORS;
  no innerHTML sinks; no secrets in web storage. Imports bounded by bytes and rows before parsing; signed export bundles
  pin every header and sign exact bytes; licensing verifies before parsing, offline.
- **Integrity under concurrency.** Approve and consume are single transactions with conditional status predicates
  (double-approve/consume structurally impossible); run transitions, event and audit rows commit together under row
  locks; scheduler claims use expiring leases; alert raise/resolve is idempotent; counters and breaker state are shared
  through Postgres; the audit hash chain uses a transaction-scoped advisory lock; retries respect idempotence and never
  extend the caller's deadline.
- **Operations.** Boot fails loudly on invalid posture or key mismatch and prints one posture block; migrations are
  forward-only and journal-consistent; `/health` reports 503 when Postgres is down; large exports stream with
  backpressure; hot lists are capped or cursor-paginated.
- **Tests and CI.** 226 files / 3175 gateway tests pass in shuffled order; CI typechecks tests, builds the SPA before the
  CSP hash test and runs the real demo path (prepare → 18/18 check → browser journey). Operator docs cite only commands
  and flags that exist; the restore drill script exists.
- **Product surface.** 84 admin routes and 17 workspace pages (three personas) with zero console errors, page errors or
  failed requests; complete dark mode; no mobile overflow; skip link and keyboard reachability; designed, actionable
  empty states everywhere; honesty labels consistent (mock labelled mock, "unmeasured" never shown as 0, anchoring
  "NOT tamper-resistant (observed)"); the admin-denial screen says the server refuses independently — and it does; the
  intake wizard, alert gating (note required, independent approver for executable remediations) and the approver's
  side-by-side context diff hold up on screen.

## 3. Confirmed findings by batch

### 3.1 Security — all fixed in `4462cde` (ADR-0167, migration 0128)

| ID | Sev | Title | Location | Status |
|---|---|---|---|---|
| AUTHZ-01 | high | Pre-auth rate limiter keyed on the attacker-chosen bearer; per-IP limit bypassed, one INSERT per junk token | apps/gateway/src/rate-limit.ts:163-169 | fixed — 4462cde (ADR-0167) |
| AUTHZ-02 | high | GET /v1/policy-simulations returns every simulation, incl. org-wide blast radius, to any authenticated user | apps/gateway/src/policy-simulation.ts:900-914 | fixed — 4462cde (ADR-0167) |
| SEC-01 | high | Credential-typed hosts (Teams/Outlook loginBaseUrl, Snowflake account) bypass the egress guard; SSRF to IMDS reproduced | apps/gateway/src/agents-connectors.ts:5162-5203 | fixed — 4462cde (ADR-0167) |
| SEC-02 | high | @xmldom/xmldom 0.8.13 (quadratic parse) under the auth-exempt SAML ACS | pnpm-lock.yaml; apps/gateway/src/route-classes.ts:391-394 | fixed — 4462cde (ADR-0167) |
| CFG-01 | high | Rotating the bearer prefix voids the per-IP limit and forces a Postgres INSERT per anonymous request | apps/gateway/src/rate-limit.ts:171-175 | fixed — 4462cde (ADR-0167) |
| AUTHZ-04 | medium | OIDC/SAML login state not bound to the initiating browser (login CSRF) | apps/gateway/src/auth.ts:1590-1629; saml.ts:437-449 | fixed — 4462cde (ADR-0167) |
| AUTHZ-05 | medium | Bootstrap token boots with a published default: full admin, no identity, no expiry, no warning | docker-compose.yml:171; apps/gateway/src/auth.ts:154-156 | fixed — 4462cde (ADR-0167) |
| AUTHZ-06 | medium | Change requester can self-report automated checks as passed and advance their own stage | apps/gateway/src/workflows.ts:1716-1778 | fixed — 4462cde (ADR-0167) |
| SEC-03 | medium | Fastify 400/413/415 parser errors surface as 500; advertised import bounds above the global bodyLimit never fire | apps/gateway/src/app.ts:642-671 | fixed — 4462cde (ADR-0167) |
| SEC-06 | medium | OTLP collector auth headers stored as plaintext jsonb outside the envelope-encryption registry | packages/db/src/schema.ts:3574 | fixed — 4462cde (ADR-0167) |
| CFG-02 | medium | `logger:false`: error handler and boot warnings are no-ops; auth failures neither logged nor audited | apps/gateway/src/app.ts:539-544 | fixed — 4462cde (ADR-0167) |
| CFG-03 | medium | Published dev data key and `dev-bootstrap` token boot with no warning on the documented compose path | docker-compose.yml:231-233 | fixed — 4462cde (ADR-0167) |
| CFG-05 | medium | Dependency exposure: of 32 HIGH advisories only the xmldom parser bugs are reachable from untrusted input | pnpm audit (reachability traced per advisory) | fixed — 4462cde (ADR-0167); remainder in §4 |
| CFG-06 | medium | SAML ACS / OIDC callback outside the strict auth bucket; each failure costs XML parse + signature check + audit row | apps/gateway/src/rate-limit.ts:78-83; saml.ts:482-543 | fixed — 4462cde (ADR-0167) |
| CFG-07 | medium | Image runs as root on a floating base tag, no HEALTHCHECK, ships source + devDependencies; core services lack a restart policy | Dockerfile:9-37; docker-compose.yml | fixed — 4462cde (ADR-0167) |
| CFG-08 | medium | pg.Pool on defaults: 10 connections, no connect/statement timeout, no TLS option; exhaustion stalls /health | packages/db/src/index.ts:71-74 | fixed — 4462cde (ADR-0167) |

A review follow-up commit on the same batch additionally disabled Fastify request logging (so query strings and the
OIDC code never reach the log) and made the SAML ACS spend the login state on a browser-binding mismatch.

### 3.2 Reliability — fixed — adc7c6c

Two IDs (`REL-01`, `REL-02`) were issued independently by rel-backend and rel-tests; the area column disambiguates.

| ID | Area | Sev | Title | Location | Status |
|---|---|---|---|---|---|
| REL-01 | rel-backend | high | pg.Pool has no `error` listener — a dropped idle Postgres connection crashes the gateway (reproduced) | packages/db/src/index.ts:72 | fixed — adc7c6c |
| REL-04 | rel-backend | high | Unauthenticated caller mints a fresh bucket (one write + one never-evicted Map entry) per request by varying the bearer | apps/gateway/src/rate-limit.ts:171-175 | fixed — adc7c6c |
| REL-01 | rel-tests | high | Gateway dies on any idle Postgres error and compose never restarts it | packages/db/src/index.ts:72-73; docker-compose.yml:147 | fixed — adc7c6c |
| REL-02 | rel-backend | medium | No graceful shutdown: no SIGTERM/SIGINT, unhandledRejection or uncaughtException handler; pool never ended | apps/gateway/src/main.ts:1-38 | fixed — adc7c6c |
| REL-03 | rel-backend | medium | `logger:false` makes `app.log.error/warn` no-ops (same root as CFG-02) | apps/gateway/src/app.ts:540 | fixed — adc7c6c |
| REL-05 | rel-backend | medium | Pool defaults: max 10, unbounded wait for a client, no statement timeout (same root as CFG-08) | packages/db/src/index.ts:72 | fixed — adc7c6c |
| REL-06 | rel-backend | medium | Workflow stage execution claim (`context.executing`) has no expiry or recovery — a crash mid-stage strands the instance | apps/gateway/src/workflows.ts:599-621 | fixed — adc7c6c |
| REL-07 | rel-backend | medium | Run budget `spentUsd` is read-modify-written without a lock | apps/gateway/src/orchestration.ts:2217-2222 | fixed — adc7c6c |
| REL-09 | rel-backend | medium | GET /v1/approvals materialises and SLA-evaluates every pending approval on every read once a routing rule exists | apps/gateway/src/app.ts:2602-2605 | fixed — adc7c6c |
| REL-10 | rel-backend | medium | Unbounded list routes and full-table aggregates on hot admin pages (/v1/runs no limit; /v1/projects aggregates all usage) | apps/gateway/src/orchestration.ts:2748-2753 | fixed — adc7c6c |
| REL-12 | rel-backend | medium | Outbound paths with no deadline: guardedFetch default, OTLP export, OIDC discovery/token | apps/gateway/src/egress-guard.ts:772-826 | fixed — adc7c6c |
| REL-13 | rel-backend | medium | Six of seven hijacked streaming routes never observe client disconnect — an abandoned SSE keeps dispatching and billing | apps/gateway/src/mcp-proxy.ts:1846-1850 (the one that does) | fixed — adc7c6c |
| REL-14 | rel-backend | medium | Gateway container has no restart policy — any process exit is a permanent outage | docker-compose.yml:147 | fixed — adc7c6c |
| REL-02 | rel-tests | medium | Server and background-job errors go to a no-op logger; there is no request log | apps/gateway/src/app.ts:539-540 | fixed — adc7c6c |
| DEMO-01 | rel-tests | medium | Native `pnpm start` demo gateway binds 0.0.0.0 with no loopback-only option | apps/gateway/src/boot.ts:77 | fixed — adc7c6c |
| CI-01 | rel-tests | medium | The nine Object-Lock "proof by attack" tests are skipped on every CI run and every dev box | apps/gateway/src/audit-chain.test.ts:1103-1110 | fixed — adc7c6c |
| CI-02 | rel-tests | medium | 34 of 38 Playwright specs never run in CI; the documented `pnpm e2e` cannot pass | apps/web/playwright.config.ts; .github/workflows/demo.yml | fixed — adc7c6c |
| CI-03 | rel-tests | medium | ci.yml budget arithmetic stale by ~2.5x; build-and-test ~13 min against a 20-min cap | .github/workflows/ci.yml:33-71 | fixed — adc7c6c |
| OPS-01 | rel-tests | medium | No SIGTERM/SIGINT handling: shutdown severs in-flight requests and skips the `app.close()` cleanup | apps/gateway/src/main.ts:22-38 | fixed — adc7c6c |

### 3.3 UI blockers — fixed (UI batch A, 2026-10-03)

| ID | Sev | Title | Location | Status |
|---|---|---|---|---|
| UIW-01 | high | Any 401 from /auth/change-password drops the user to a blank login screen while the server session stays alive | apps/web/src/api/client.ts:86-89 | fixed — c5f1943, 7b8baa0 (isSessionLoss; unit + mock e2e; negative controls) |
| UXJ-01 | high | 38 query-backed tables render a false "empty" state when the API call fails | apps/web/src/ui/kit.tsx:470-478 | fixed — 2ec3d12, 7b8baa0 (Table error/onRetry on 43 tables; held rows + "couldn't refresh" notice; unit + 5 mock e2e cases) |

### 3.4 UI polish — fixed — pending (UI batch, 2026-10-03)

| ID | Sev | Title | Location | Status |
|---|---|---|---|---|
| UIA-01 | medium | Verify chain reports a foreign/stale anchor as a red "Anchor mismatch" on the demo audit page | apps/gateway/src/audit-chain.ts:182 | fixed — pending (UI batch, 2026-10-03) |
| UIA-02 | medium | Audit log silently shows only the newest 100 of 406 rows; no pagination, no "showing N of M" | apps/web/src/views/admin/governance/AuditLogPage.tsx:63-66 | fixed — pending (UI batch, 2026-10-03) |
| UIA-03 | medium | Raw zod validation text reaches users; doubled "validation — validation —" prefix | apps/web/src/api/client.ts:42-70 | fixed — pending (UI batch, 2026-10-03) |
| UIA-04 | medium | Fingerprint stat tiles overflow and are clipped at 1366 px | apps/web/src/views/admin/settings/DataKeyPage.tsx:116-120 | fixed — pending (UI batch, 2026-10-03) |
| UIB-02 | medium | Server validation errors render raw zod field keys and the doubled prefix | apps/web/src/views/admin/adminKit.tsx:350-363 | fixed — pending (UI batch, 2026-10-03) |
| UIB-03 | medium | Clicking a use-case row scrolls its title and Approve/Close under the sticky header | apps/web/src/views/admin/governance/UseCasesPage.tsx:291 | fixed — pending (UI batch, 2026-10-03) |
| UIB-04 | medium | "Daily AI spend — last 14 days" renders as one solid block when only one day has data (same as UXJ-12) | apps/web/src/views/admin/governance/PosturePage.tsx:140-170 | fixed — pending (UI batch, 2026-10-03) |
| UIW-02 | medium | Approver reads the submitted intake as raw Markdown + fenced JSON | apps/web/src/views/inbox/InboxPage.tsx:279-282 | fixed — pending (UI batch, 2026-10-03) |
| UIW-03 | medium | Non-admin on /ui/admin/users sees the full admin navigation beside the refusal card | apps/web/src/shell/suites.tsx:460-475; AppShell.tsx:92 | fixed — pending (UI batch, 2026-10-03) |
| UIW-05 | medium | "Plan a run" / "Start a change" forms collapse at phone width | apps/web/src/ui/kit.tsx:81 | fixed — pending (UI batch, 2026-10-03) |
| UIW-06 | medium | Run detail header actions overlap the page title at phone width | apps/web/src/shell/AppShell.tsx:385 | fixed — pending (UI batch, 2026-10-03) |
| UIW-07 | medium | Empty title/description silently creates "untitled run" / "untitled change" (client-side fallback bypasses server min(1)) | apps/web/src/views/runs/RunsPage.tsx:252 | fixed — pending (UI batch, 2026-10-03) |
| UIW-08 | medium | Missing/malformed record pages show raw server codes; project page renders chrome for a non-existent project | apps/web/src/views/runs/RunDetailPage.tsx:332 | fixed — pending (UI batch, 2026-10-03) |
| UIW-09 | medium | Workflow pages show template/stage/kind identifiers where names belong | apps/web/src/views/workflows/WorkflowDetailPage.tsx:145-147 | fixed — pending (UI batch, 2026-10-03) |
| UXJ-02 | medium | Clicking a lower alert opens the detail panel off-screen; no scroll, no URL change | apps/web/src/views/admin/governance/GovernanceAlertsPage.tsx | fixed — pending (UI batch, 2026-10-03) |
| UXJ-04 | medium | Error messages are raw server codes or browser exceptions ("Failed to fetch", "not_a_project_member") | apps/web/src/api/client.ts:64-68 | fixed — pending (UI batch, 2026-10-03) |
| UXJ-06 | medium | "AI intake" from the sidebar pre-fills a fictional Acme Bank use case in every field | apps/web/src/views/admin/governance/IntakeWizardPage.tsx:67-88 | fixed — pending (UI batch, 2026-10-03) |
| UXJ-08 | medium | First-run setup shows raw JSON, snake_case keys and red "drift" on satisfied steps; numbers contradict Getting started | apps/web/src/views/admin/settings/FirstRunPage.tsx | fixed — pending (UI batch, 2026-10-03) |

### 3.5 Deferred — confirmed, low severity, not fixed in this cycle (89)

| ID | Sev | Title | Location | Status |
|---|---|---|---|---|
| AUTHZ-03 | low | Credential prefixes (and a short bootstrap token in full) persisted in plaintext in `rate_limit_counters.bucket` | apps/gateway/src/rate-limit.ts:155-169 | deferred (low) |
| AUTHZ-07 | low | Holder of a revoked/expired key can write ~6,000 hash-chained audit rows per minute per key | apps/gateway/src/auth.ts:216-267 | deferred (low) |
| AUTHZ-08 | low | TOTP failures never feed the account lockout; only a per-IP bound during the pending window | apps/gateway/src/auth.ts:1000-1027 | deferred (low) |
| AUTHZ-09 | low | Must-change-password and MFA-enrolment gates apply only to cookie sessions, not API-key/bootstrap requests | apps/gateway/src/app.ts:931-1017 | deferred (low) |
| AUTHZ-10 | low | OIDC redirect_uri, SAML entityId/ACS and resource metadata built from the unvalidated Host header | apps/gateway/src/auth.ts:1550-1594; saml.ts:114-116 | deferred (low) |
| AUTHZ-11 | low | No ceiling on concurrent sessions per user | apps/gateway/src/auth.ts:433-462 | deferred (low) |
| SEC-04 | low | CSV exports do not neutralise spreadsheet formula triggers | apps/gateway/src/app.ts:3918-3970 | deferred (low) |
| SEC-05 | low | No decoded-size ceiling on upstream responses (unbounded gzip/br inflation) | apps/gateway/src/pinned-fetch.ts:206-266 | deferred (low) |
| SEC-07 | low | 64 open advisories in the lockfile; fastify/drizzle-orm/react-router need bumps (addressed by §4) | pnpm-lock.yaml | deferred (low) |
| SEC-08 | low | Admin-authored eval regexes run against model output with no ReDoS guard on a non-admin-triggerable route | packages/shared/src/evals.ts:386-756 | deferred (low) |
| SEC-09 | low | External links from API data have no scheme allow-list (mitigated by CSP) | apps/web/src/views/pm/PmAndDecisions.tsx:178 | deferred (low) |
| SEC-10 | low | Several route schemas accept unbounded arrays, relying only on the 1 MiB body limit | packages/shared/src/index.ts (multiple) | deferred (low) |
| CFG-04 | low | Seeded one-time passwords, API keys and the PM webhook secret are printed to stdout and persist in the container log | apps/gateway/src/seed.ts:1343-1362 | deferred (low) |
| CFG-09 | low | Auth bucket is per-IP and counts successful logins — an office NAT hits 429 after 10 sign-ins in 5 minutes | apps/gateway/src/rate-limit.ts:63-67 | deferred (low) |
| CFG-10 | low | Authenticated API responses carry no Cache-Control | apps/gateway/src/app.ts:694-740 | deferred (low) |
| CFG-11 | low | scrypt N=2^14 below current OWASP guidance; documented rehash-on-login not implemented | apps/gateway/src/auth.ts:277-328 | deferred (low) |
| CFG-12 | low | Caddy overwrites the gateway's Referrer-Policy with a weaker value; stale comments | infra/caddy/Caddyfile:95-112 | deferred (low) |
| CFG-13 | low | Boot posture block prints `/app` and `/admin`, both 302s to `/ui` since ADR-0033 | apps/gateway/src/boot.ts:222-224 | deferred (low) |
| CFG-14 | low | Migrations run on every boot with no cross-process lock; two replicas race | packages/db/src/migrate.ts:4-6 | deferred (low) |
| CFG-15 | low | CSP still allows `style-src 'unsafe-inline'` although the blocker was removed | apps/gateway/src/security-headers.ts:20-26 | deferred (low) |
| REL-08 | low | Scheduler releaseJob clears the lease unconditionally by job name — a stolen lease is clobbered | apps/gateway/src/scheduler.ts:400-424 | deferred (low) |
| REL-11 | low | Signed export bundles assembled fully in memory and gzip'd synchronously at level 9 on the event loop | apps/gateway/src/export-bundle.ts:450-462 | deferred (low) |
| REL-15 | low | Migration journal idx gap (0065 absent); all pending migrations apply in one transaction | packages/db/migrations/meta/_journal.json | deferred (low) |
| DEMO-02 | low | Live demo sign-ins run against production lockout defaults with no documented recovery | apps/gateway/src/rate-limit.ts:66-83 | deferred (low) |
| OPS-02 | low | /health is a DB-coupled readiness check labelled liveness; no /ready | apps/gateway/src/app.ts:3386-3397 | deferred (low) |
| OPS-04 | low | Image runs as root, carries devDependencies and 227 compiled test files (image part closed by CFG-07) | Dockerfile:9-40 | deferred (low) |
| CI-05 | low | "Demo journey" reads green-by-skip on most pushes | .github/workflows/demo.yml:44-71 | deferred (low) |
| DEMO-04 | low | Port-taken, Postgres-down and regenerated-key failures surface as raw stack traces | apps/gateway/src/main.ts:30-38 | deferred (low) |
| DEMO-03 | low | demo:check and demo:gate mint a new admin API key for Ada on every run and never revoke it | apps/gateway/src/demo-check-lib.ts:62 | deferred (low) |
| OPS-03 | low | BACKUP_RESTORE.md contradicts itself and PENDING on re-encryption / Object-Lock sink | docs/deployment/BACKUP_RESTORE.md:57,192-194 | deferred (low) |
| CI-04 | low | Two latent flakiness patterns: reserved-then-reused ephemeral port; 20 files mutating process.env | apps/gateway/src/g2-upstream-deadlines.test.ts:301 | deferred (low) |
| CI-06 | low | ci.yml, demo.yml and integrations.yml set no `permissions:` block | .github/workflows/*.yml | deferred (low) |
| UIA-05 | low | Control names are raw camelCase keys and snake_case enums; "(s)" plurals | apps/web/src/views/admin/settings/EnforcementPosturePage.tsx:121 | deferred (low) |
| UIA-06 | low | Raw JSON evidence and snake_case step ids on first-run steps (overlaps UXJ-08) | apps/web/src/views/admin/settings/FirstRunPage.tsx:161 | deferred (low) |
| UIA-07 | low | "Next effective entry" degrades to a slug when outside the current filter | apps/web/src/views/admin/governance/RegulatoryIntelligencePage.tsx:111 | deferred (low) |
| UIA-08 | low | ADR numbers, API routes and table names in a stat label and help text | apps/web/src/views/admin/cost/BillingPage.tsx:171 | deferred (low) |
| UIA-09 | low | At 390 px the approvals "Name this view" input collapses to 22 px | apps/web/src/views/admin/governance/ApprovalsAdminPage.tsx | deferred (low) |
| UIA-10 | low | ADR reference in a card heading, table name, all-caps emphasis, "MTOK" header | apps/web/src/views/admin/integrations/AgentsPage.tsx:492 | deferred (low) |
| UIA-11 | low | Page subtitle uses a snake_case stage name | apps/web/src/views/admin/integrations/GitConnectionsPage.tsx:43-44 | deferred (low) |
| UIA-12 | low | ADR/migration/HTTP-code references in operator text; Runs table lacks the standard empty state | apps/web/src/views/admin/governance/EvalsPage.tsx | deferred (low) |
| UIA-13 | low | "(s)" plurals in audit reasons and cost tiles despite a plural() helper | apps/gateway/src/use-cases.ts:739; shadow-ai.ts:291 | deferred (low) |
| UIA-14 | low | Raw ISO timestamps, env-var name, HMAC construction and an API path in operator text | apps/web/src/views/admin/settings/DataKeyPage.tsx | deferred (low) |
| UIA-15 | low | HTTP status codes, env var, table.column and ADR references in help text | apps/web/src/views/admin/cost/CostConsolidationPage.tsx | deferred (low) |
| UIA-16 | low | Invalid-JSON error rendered ~1300 px away from the form that produced it | apps/web/src/views/admin/compliance/CompliancePacksPage.tsx:219 | deferred (low) |
| UIA-17 | low | Self-review row says "reason (optional)" but approving without one is refused | apps/web/src/views/admin/governance/ApprovalsAdminPage.tsx:217 | deferred (low) |
| UIA-18 | low | Card titles are `<div>`s: one H1 and no H2/H3 per page; document.title always "regulAIt" | apps/web/src/ui/kit.tsx:348-352 | deferred (low) |
| UIA-19 | low | Raw enum `map_by_model` in a select; all-caps enum keys in the dial glossary | apps/web/src/views/admin/identity/ClientAccessPage.tsx:220 | deferred (low) |
| UIA-20 | low | Recent decisions show `detector:category` codes as findings | apps/web/src/views/admin/governance/GuardrailsPage.tsx:450 | deferred (low) |
| UIA-21 | low | "sha256 at rest" card title, "one-time pw" abbreviation, lowercase action buttons | apps/web/src/views/admin/identity/UsersPage.tsx:843 | deferred (low) |
| UIA-22 | low | Currency formatter drops trailing zeros ("$0.1") | apps/web/src/api/format.ts:3-6 | deferred (low) |
| UIA-23 | low | "Post to chat" enabled although no chat workspace is connected | apps/web/src/views/admin/governance/GovernanceAlertsPage.tsx | deferred (low) |
| UIA-24 | low | Generated-at timestamps formatted differently on neighbouring demo pages | apps/web/src/views/admin/governance/TrustDashboardPage.tsx:133 | deferred (low) |
| UIB-01 | low | "Disable" on a scheduled job fires immediately with no confirmation or reason | apps/web/src/views/admin/settings/SchedulerPage.tsx:227-229 | deferred (low) |
| UIB-05 | low | Card titles are `<span>`s: exactly one heading per admin page (same as UIA-18) | apps/web/src/ui/kit.tsx:349-350 | deferred (low) |
| UIB-06 | low | Agent inventory table overflows at 1366 px behind an unsignalled horizontal scroll | apps/web/src/views/admin/governance/InventoryPage.tsx | deferred (low) |
| UIB-07 | low | Page copy says "Six governance sweeps" while 15 jobs are registered | apps/web/src/views/admin/settings/SchedulerPage.tsx:124-125 | deferred (low) |
| UIB-09 | low | snake_case enum values shown where human labels belong | apps/web/src/views/admin/cost/ReportsPage.tsx:125 | deferred (low) |
| UIB-10 | low | "(s)" / "(es)" pluralisation throughout counters | apps/web/src/views/admin/governance/InventoryPage.tsx:251-376 | deferred (low) |
| UIB-11 | low | Licensing page prints the server's absolute filesystem path and a raw ISO timestamp | apps/web/src/views/admin/settings/LicensingPage.tsx:290 | deferred (low) |
| UIB-12 | low | Posture cards repeat the same sentence twice; red-team line three times | apps/web/src/views/admin/governance/PosturePage.tsx:381 | deferred (low) |
| UIB-13 | low | Findings listed per holder with the identical sentence 21 times, plus camelCase evidence keys | apps/web/src/views/admin/governance/RecommendationsPage.tsx:90 | deferred (low) |
| UIB-14 | low | Triage table has a blank "Action" column and a row whose "What" is "demo-project" | apps/web/src/views/admin/governance/ReviewWorkbenchPage.tsx:487-496 | deferred (low) |
| UIB-15 | low | Client-side JSON parse failures surface the engine's message as a toast with no field highlight | apps/web/src/views/admin/governance/ModelRiskPage.tsx | deferred (low) |
| UIB-17 | low | Unknown admin URLs silently redirect instead of a not-found page (same as UIW-04, UXJ-14) | apps/web/src/App.tsx:247 | deferred (low) |
| UIB-19 | low | At 390 px several tables clip inside the card without a scroll cue | apps/web/src/views/admin/observability/TracesPage.tsx | deferred (low) |
| UIB-20 | low | POST /v1/users returns the full users row including secret-bearing columns (same as UXJ-16) | apps/gateway/src/app.ts:1112-1116 | deferred (low) |
| UIW-04 | low | No 404 page: unknown routes redirect to Home | apps/web/src/App.tsx:252 | deferred (low) |
| UIW-10 | low | Cost pages print "$0.1", an all-caps server sentence as caption, `model_routing` as a technique name | apps/web/src/api/format.ts:3-6 | deferred (low) |
| UIW-11 | low | Authenticator enrolment shows only a raw base32 secret and otpauth:// URI — no QR code | apps/web/src/views/account/AccountPage.tsx:388-402 | deferred (low) |
| UIW-12 | low | Single heading per page; access-refusal page has no H1 (same as UIA-18) | apps/web/src/ui/kit.tsx:349-352 | deferred (low) |
| UIW-13 | low | Node rows read "…API design design"; edit control is an unlabeled pencil | apps/web/src/views/runs/RunDetailPage.tsx:468-469 | deferred (low) |
| UIW-14 | low | Inbox meta line prints the raw approval objectType | apps/web/src/views/inbox/InboxPage.tsx:216 | deferred (low) |
| UIW-15 | low | Locked-out/deactivated accounts get "password is incorrect" with no hint (by design; no recovery path shown) | apps/gateway/src/auth.ts:955-962 | deferred (low) |
| UIW-16 | low | "Unattributed is a real bucket" note shown even with no unattributed spend | apps/web/src/views/spend/SpendPage.tsx:344-346 | deferred (low) |
| UIW-17 | low | Identity card shows developer values ("signed in via session", truncated user-id chip) | apps/web/src/views/account/AccountPage.tsx:58-72 | deferred (low) |
| UIW-18 | low | "Plan only" explanation written for developers (instanceId, mutating mode) | apps/web/src/views/workflows/WorkflowDetailPage.tsx:165-172 | deferred (low) |
| UXJ-03 | low | Approver sees raw markdown in a 200 px code box and no stakes summary (overlaps UIW-02) | apps/web/src/views/inbox/InboxPage.tsx:277-283 | deferred (low) |
| UXJ-05 | low | New non-admin with zero grants hits dead ends with no in-product "request access" | apps/web/src/views/chat/ChatPage.tsx; RunsPage.tsx | deferred (low) |
| UXJ-07 | low | Two different intake wizards with different step names; Home links to the other one | apps/web/src/views/home/HomePage.tsx:152 | deferred (low) |
| UXJ-09 | low | Every tab title is "regulAIt"; no favicon; /favicon.ico answers 401 JSON | apps/web/index.html:7 | deferred (low) |
| UXJ-10 | low | Brand spelled three ways on the first screens | apps/web/src/views/auth/LoginPage.tsx:27-35; ui/Brand.tsx | deferred (low) |
| UXJ-11 | low | "/" nav filter matches sidebar labels only | apps/web/src/shell/AppShell.tsx:93-108 | deferred (low) |
| UXJ-12 | low | Daily spend chart renders as one solid block with one day of data (same as UIB-04, fixed there) | apps/web/src/views/admin/governance/PosturePage.tsx:150-165 | deferred (low) |
| UXJ-13 | low | Session expiry bounces to /login with no explanation; late submit shows bare "unauthenticated" | apps/web/src/App.tsx:120; LoginPage.tsx | deferred (low) |
| UXJ-14 | low | Unknown URLs silently redirect to Home with no message | apps/web/src/App.tsx:252 | deferred (low) |
| UXJ-15 | low | Forced password change states no rules until a 422 round-trip | apps/web/src/views/auth/ForcedPasswordChange.tsx | deferred (low) |
| UXJ-16 | low | POST /v1/users returns passwordHash / totpSecretCiphertext / lockedUntil columns (same as UIB-20) | apps/gateway/src/app.ts:1114-1118 | deferred (low) |
| UXJ-17 | low | Use-case workspace page has no breadcrumb or back link | apps/web/src/views/admin/governance/UseCaseOverviewPage.tsx | deferred (low) |
| UXJ-18 | low | At phone width the audit table and dependency graph are cut mid-word with no scroll affordance | apps/web/src/ui/kit.module.css:135-136 | deferred (low) |

## 4. Dependency upgrade — `22e83e7` on branch `wt-deps` (not pushed; main checkout untouched)

- `pnpm audit` before: 64 (0 critical / 32 high / 30 moderate / 2 low). After: 6 (0 / 0 / 6 / 0). Every HIGH removed.
- Direct bumps: `fastify ^5.4.0 → ^5.12.2` (apps/gateway; resolves 5.10.0 → 5.12.5), `drizzle-orm ^0.44.2 → ^0.45.2`
  (packages/db; resolves 0.44.7 → 0.45.3; drizzle-kit range unchanged, `drizzle-kit generate` not run, migrations untouched).
- Transitive refresh via `pnpm update -r` within existing ranges, no overrides needed: fast-uri, ip-address, js-yaml,
  @xmldom/xmldom 0.8.13 → 0.8.15, @grpc/grpc-js, brace-expansion, nanoid, qs, hono (via @modelcontextprotocol/sdk
  1.29 → 1.32, @hono/node-server 1.x → 2.1.3 — ADR-0106 shim still correct), react-router 6.30.4 → 6.30.6, pg,
  openid-client, jose, @azure/identity, AWS SDK clients, @tanstack/react-query, pino, ws, rollup, tsx.
- Remaining 6 moderates each need a major bump of the parent and were left alone: esbuild 0.18 via drizzle-kit loader
  (dev-only), uuid 8.3.2 via @azure/ms-rest-js (deprecated chain), react-router 6.30.6 x2 (patched only in 7.x),
  vitest/@vitest/mocker 3.2.7 (patched only in 4.x, dev-only).
- Verification on a fresh worktree install: `pnpm -r build` 16/16; packages/shared 1188 tests; apps/web unit 49;
  gateway full suite 226/226 files, 3175 passed / 9 skipped (20.1 min); Playwright demo-mock 7/7.
- Merge note: ADR-0167 (`4462cde`) pins @xmldom/xmldom 0.8.15 via `pnpm.overrides`; `22e83e7` reaches the same version
  in-range. The two branches must land with one reconciled lockfile.

## 5. Verifier's missed items — unverified leads

Reported by verifiers as gaps in the finder's list; deduplicated across lenses; none independently verified. "Likely
closed by ADR-0167 §n" means the ADR text plainly covers it; the code was not re-checked.

Security
- [high] `automated_check` stages auto-pass every check nobody reported (`workflows.ts:686-727`), so silence is green;
  not disclosed. Extends AUTHZ-06; ADR-0167 §6 covers self-reports only.
- [high] SCIM bucket keyed on the unverified bearer (`rate-limit.ts:165-169`, 3000/min per invented prefix) — same
  bypass as AUTHZ-01/CFG-01. Likely closed by §1 (pre-auth IP-keyed; `cred:scim:<id>` post-auth).
- [medium] AUTH_EXEMPT SSO `/start` routes bucketed on the bearer; each hit does an uncached OIDC discovery and inserts a
  login-state row. Keying likely closed by §1; the per-hit discovery fetch and state-row growth are not addressed.
- [medium] Local rate-limit `Map` never evicted → heap growth per unique bearer. Likely closed by §1 `LOCAL_BUCKET_CAP`.
- [medium] First 32 chars of the raw bearer (a short bootstrap token in full) persisted in `rate_limit_counters.bucket`;
  a pg backup within the 1 h retention carries a live admin credential. Overlaps AUTHZ-03; §1 keys the credential tier
  on row ids, which should make it moot.
- [medium] Auth gate is a `preHandler`, so bodies up to 1 MiB are parsed before any credential check (unauthenticated
  CPU amplification); move it to `onRequest`. Not in ADR-0167.
- [medium] Teams/Outlook/Snowflake upstream response bodies are thrown into error messages and returned to the
  non-admin invoker as 502 `detail` (made SEC-01 a read oracle). §2 stops echoing the token endpoint; the Snowflake
  statements path is not named.
- [medium] `loginBaseUrl` accepts `http:` and a query component. §2 restricts to a path-only URL; `http:` still allowed.
- [medium] Under strict posture the compiled-default branch never assigned `connectorFetch` (admitted vendor host reached
  over the global fetch). §2 says the adapter now receives the guarded fetch — unverified.
- [medium] `POST /v1/evals/runs` runs scorers (incl. SEC-08 regexes, external scorers) on the request path (`evals.ts:1636`).
- [low–medium] Queue reads lazily materialise approvals and attribute `approval-routed` audit rows to whichever reader
  opened their inbox first (`workbench.ts:150-156`); inactive in the demo DB.
- [low] `/health` is allow-listed from the limiter and runs `select 1` per call — unmetered anonymous DB round-trips.
- [low] Hijacked SSE responses skip the `onSend` security headers (agents-connectors, compat-*, orchestration).
- [low] Seed mints three persona API keys on every container start (SEED_DEMO=1), never revokes them, logs them.
- [low] `x-api-key` clients are bucketed per IP, not per key.
- [low] POWER_SCHEDULE.md claims `restart: unless-stopped` on every service; compose had it only on caddy (§11 adds it).

Reliability / operations
- Node runs as PID 1 with no init (`Dockerfile:40`): SIGTERM ignored, every stop ends in SIGKILL. Pairs with OPS-01.
- DEMO_SCRIPT §0 requires the publicly committed `e2e-bootstrap-token`; with the 0.0.0.0 bind (DEMO-01) a presenter who
  keeps it exposes a known admin credential on the LAN.
- Boot banner prints `/app` and `/admin` (= CFG-13, deferred); the presenter reads this line.

UI / UX
- [high] A wrong TOTP code during enrolment logs the user out (same 401 handler as UIW-01); `/auth/totp/enroll` mints a
  new secret per call, so the authenticator entry already added is dead. Also hits the forced-MFA gate.
- [medium] react-query cache not cleared on sign-out/401: the previous user's inbox and home data render for the next
  user in the same tab (reproduced; `SessionContext.tsx:74-82`). Fix: `queryClient.clear()`.
- [medium] "Harden enforcement controls" applies with no confirmation (`EnforcementPosturePage.tsx:109-113`).
- [low] While locked, every retry re-arms the lockout (`auth.ts:917-931`); audit timestamps are viewer-local with no zone
  marker; agent enable/disable has no confirmation; scheduler page shows raw ISO stamps once a job has run and the
  gateway's "six sweeps" status string carries the UIB-07 stale count.
- [fix-safety] UXJ-06's one-line fix breaks `demo-governance.mock.spec.ts:130-135, 345`, which rely on the prefill.
- Evidence corrections: UIW-07's fix is client-only (server already enforces min(1)); UIW-03's line is
  `AppShell.tsx:92`; SEC-07's cited `app.ts:777` is the interception hook — the auth gate is the preHandler at `:837`.

### 5.1 Lead verification (2026-10-03)

Five leads from the list above were run to ground, each against a live gateway or the browser, not by reading:

| Lead | Verdict | Where it went |
|---|---|---|
| L1 — `automated_check` auto-pass on silence | **confirmed, high**: a template with two checks, gate approved before any CI posted, every check evaluated `passed` and the instance advanced; a `failed` report afterwards was refused as late (`workflows.ts` check executor ~720; `workflow-checks.test.ts` pins the behaviour as the contract) | owner decision — PENDING.md "L1" row (disclose vs. fail-on-silence with per-template opt-in) |
| L2 — wrong TOTP code during enrolment logs the user out | **confirmed, medium**: same 401 handler as UIW-01 | fixed in UI batch A (c5f1943 + 7b8baa0: only a session-ending 401 routes to /login; a dead session on the forced-change forms still does) |
| L3 — bodies parsed before the credential check | **confirmed, low–medium**: real, but bounded by the pre-auth IP-keyed limiter of ADR-0167 §1 | owner decision — PENDING.md "L3" row (move the gate to `onRequest` in the post-demo hardening batch, or wait for a measured need) |
| L4 — react-query cache survives sign-out / 401 | **confirmed, medium–high**: the previous user's inbox and home data rendered for the next user in the same tab | fixed in UI batch A (78dab52: cache cleared at every identity boundary) |
| L5 — SCIM bucket keyed on the unverified bearer | **closed**: ADR-0167 §1 keys pre-auth traffic by IP and SCIM by `cred:scim:<id>` after verification; re-checked in code | no action |

The remaining leads stand as written: unverified, and listed so the next review starts from them rather than from zero.

## 6. Coverage — what was not reviewed

- **No finder ran the gateway vitest suite** (rel-tests used the provided shuffled-run log); security and reliability
  finders ran no Playwright suite; branch protection was not checked (no API access).
- **Security**: Cedar/ABAC semantics; `evaluateAgent`/`evaluateTool` internals; MCP proxy dispatch and governed-evaluate;
  ChatOps/PM signature crypto; SCIM Users/Groups handlers; group-role reconciliation; MCP SDK OAuth discovery; cloud SDK
  clients beyond endpoint source; the 20 `.passthrough()` compat schemas downstream; PII scrub correctness; audit-chain
  and anchor mechanics; licensing; Terraform and the AWS account; MinIO/Object Lock; Postgres server config; whether the
  demo box's live `.env` overrides dev defaults. Disclosed-by-design items not re-reported (ADR-0043 MCP LAN posture,
  dev-only export keypair, single-node).
- **Reliability**: ~550 routes sampled, not enumerated, for pagination; SCIM create/replace and config-version
  activation internals; provider packages' own timeouts; compat semantic-cache, copilot apply and hardened-preset
  atomicity (open AER items); SIGTERM reasoned from code; migration 0108 preflight; licensing keyring; packages/* suites
  for flakiness; whether `apply-update-bundle.sh` enforces a backup; Kong harness.
- **UI**: no destructive or shared-state actions (approve/deny, Harden, Switch mode, organization or credential saves,
  Scan now, red-team runs, reports, bulk approvals, Prune, revoke/delete); no screen-reader or axe run; contrast judged
  visually; mobile on a subset of pages, light only; not exercised: the 4-step `/admin/use-cases` form, Chat/Runs as a
  user *with* grants, ChatOps/Copilot/Shadow-AI imports, Review workbench and Approvals-admin decide paths, deploy-gate
  CLI beat, audit-bundle contents, SSO/API-key sign-in, MFA activation, performance under load.
- **Side effects left in the shared demo DB**: a few failed-submission audit rows; Dana's and Avery's passwords
  re-minted; one deactivated throwaway user; Dana's un-activated TOTP enrolment; test users `uxj-admin@`, `uxj-user@`
  and `reviewer-b@regulait.local`; one submitted use case "Claims-note summariser (UXJ)" pending in Avery's inbox; the
  deps worktree database `deps1`.
