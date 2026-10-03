# ADR-0167 — The security review batch: honest buckets, typed hosts, bound logins, named secrets

- **Status:** Accepted
- **Date:** 2026-10-02
- **Migration:** 0128 (`org_settings.tracing_otlp_headers_ciphertext`)
- **Findings closed:** AUTHZ-01, AUTHZ-02, AUTHZ-04, AUTHZ-05, AUTHZ-06, SEC-01, SEC-02, SEC-03,
  SEC-06, CFG-01, CFG-02, CFG-03, CFG-05 (the reachable half), CFG-06, CFG-07, CFG-08

## Context

The owner asked for a full review of what has been built with security and reliability first.
Sixteen findings came back confirmed by two independent verifiers, several with reproductions
against the built gateway on a fresh database. They are not one defect; they are one *shape* of
defect repeated across layers: a control whose stated property did not hold for the input an
attacker actually controls. The rate limiter bucketed on a header nobody had verified. The egress
guard checked the URL an admin typed into `baseUrl` and not the URL an admin typed into the
credential. The login flow bound the authorization code to the server-side row and not the row
to the browser. The custody probe enveloped every credential column except the one that was a
jsonb. The error handler named every domain error and not the parser's own. The posture block
printed every deployment fact except the two that were secrets printed in the public repository.

This ADR records the batch as one decision because the fixes share one rule, stated once:

> **A control is keyed on, checks, or reports the thing the caller cannot choose.**

## Decision

### 1. The HTTP rate limiter has two tiers, and the pre-auth tier is keyed on the IP only (AUTHZ-01, CFG-01, CFG-06)

`rateLimitKey` used to return `key:<first 32 chars of the bearer>` for any request carrying an
`Authorization` header, *before* `authenticate()` ran. The bucket was therefore a string the
caller minted: rotating the bearer on every request never met any ceiling, voided the 1200/min
per-IP bound on every non-login route, and — because ADR-0125's shared store writes one row per
new bucket — cost Postgres one `INSERT` per request, the exact amplifier that ADR says the local
pre-filter prevents. Reproduced: 2000 distinct junk bearers from one address, 2000 allowed, 2000
rows.

Now:

- **Pre-auth (onRequest), every bucket is IP-keyed.** `ip:<ip>` for anonymous requests at
  `globalMax`; `ipk:<ip>` for requests *carrying* a bearer at `apiKeyMax` — the larger ceiling
  keeps a NAT full of service accounts from being throttled by its neighbours, which is the
  reason the per-key bucket existed; but it is still the address, never the token. The
  `auth:<ip>` spray bucket is unchanged.
- **Post-auth (the auth preHandler and the SCIM scope's token check), the credential tier.** A
  second `createRateLimit` over the same shared store, keyed `cred:key:<api_keys.id>`,
  `cred:vkey:<id>`, `cred:bootstrap`, `cred:scim:<id>` — the *stored row's id*, which no string
  rotation produces. ADR-0037's "limited per scim_token" lives entirely here. `AuthContext` gains
  `apiKeyId` for exactly this.
- **`sso:<ip>`** for the SAML ACS and the OIDC callback (CFG-06): an anonymous ACS failure costs
  an XML parse, a signature check and a hash-chained audit row, so it cannot ride the 1200/min
  anonymous allowance — but a corporate NAT signs hundreds of people in at nine o'clock, so it
  cannot ride the 10-per-5-minutes spray bucket either. 120/min per IP, env-overridable. The
  SAML sweep of the two short-lived tables runs at most once a minute per process rather than on
  every anonymous POST.
- **The local pre-filter is bounded** (`LOCAL_BUCKET_CAP`): past 10 000 entries a bump sweeps
  rolled windows, then drops the oldest-opened buckets. Dropping a live one costs correctness
  nothing — Postgres is the authority.

Two writes per authenticated request instead of one is the cost, bounded by the ceilings. The
rate-limit suite's old "a bearer gets its own larger bucket pre-auth" pin was the defect written
as a test; it is replaced by "rotating a junk bearer from one IP meets the per-IP ceiling and
costs one counter row", plus the credential-tier and SSO-bucket proofs.

### 2. A host named by a credential is a typed destination (SEC-01)

"No override means no check" (connection-egress.ts) is an SSRF argument about hosts nobody can
type. Three connector kinds reach a host somebody *did* type, through the credential JSON:
`loginBaseUrl` for teams and outlook, and `https://<account>.snowflakecomputing.com` for
snowflake. With no `baseUrl` override those adapters got the global `fetch`: no allow-list, no
private-range/IMDS check, no DNS pin, redirects followed, no audit row — and the non-admin invoke
route echoed the upstream body back as `detail`. Reproduced with the built package: the Teams
adapter POSTed `client_secret=…` to `http://169.254.169.254/latest/…/oauth2/v2.0/token`.
ADR-0034 §"only an admin can set it" already rejected admin-only as a mitigation for this
primitive.

`guardCredentialDerivedCall` now sits where the global fetch was handed out, for the three kinds
in `CREDENTIAL_HOST_CONNECTOR_KINDS`: the *typed* host is adjudicated against the allow-list
under every posture, exactly like a `baseUrl`; the vendor's *compiled* hosts the same call will
reach (Bot Connector, Graph, the default Entra login host) follow the deployment posture exactly
as `decideCompiledDefault` applies it everywhere else — adjudicated under `strict`, admitted
under `hosted` via synthetic allow entries handed to the guarded fetch, which still pins, still
refuses redirects, still blocks private ranges. The adapter receives the guarded fetch and every
URL it builds is re-checked. Under `hosted`, a Snowflake connector with no `baseUrl` now needs an
allow entry for its account host; a Teams/Outlook connector with a *typed* login host needs one
for that host. That is the behaviour change, and it is the same one the ChatOps courier already
applies to the same adapter.

Alongside: `loginBaseUrl` must be a plain http(s) URL with at most a path (no credentials,
query or fragment — the adapter appends the token path, so a `?` let the field choose the whole
request); `account` must be a hostname label; the teams/outlook credential shape is validated at
write time like snowflake's already was; `connectorDefaultBaseUrl("outlook")` names the Graph
default so strict posture adjudicates it rather than refusing it as unknown; and the token
endpoint's response body is **never echoed** — a JSON `error`/`error_description` is relayed
(truncated), anything else is withheld with its size.

### 3. The list of policy simulations is scoped like its detail route (AUTHZ-02)

`GET /v1/policy-simulations` selected every column of every row for any authenticated caller,
including `scopeUserIds` (NULL = org-wide) and the named `blastRadius`, while the detail route
one line down refused exactly that data to a narrower caller. A non-admin now sees a run only if
they requested it or its stored scope lies entirely inside their team visibility, and the list is
a *summary* — counts, headline, fidelity — with the named radius and the scope left to the detail
route and its guard. The only UI consumer (an admin page) reads none of the dropped fields.

### 4. SSO login state is bound to the browser that started it (AUTHZ-04)

PKCE and the nonce bind the *code* to the server-side row. Nothing bound the row to a user
agent, so a victim who followed an attacker's callback URL was signed in as the attacker. `/start`
now sets a cookie whose value is an HMAC of the state under the data key (no column, replica-safe,
uncomputable without the key); the return leg requires it to match, refuses *before* the token
exchange or the XML parse, audits the mismatch (`oidc-login-browser-mismatch`,
`saml-login-browser-mismatch`) and still spends the state. OIDC rides `SameSite=Lax` (the
callback is a top-level GET). SAML's ACS is a cross-site POST, which a Lax cookie never
accompanies, so its binding rides `SameSite=None; Secure` — which exists only over TLS. Over
plaintext http the SAML binding is therefore neither set nor demanded; that deployment is already
handing its session cookie to the wire, and this ADR does not pretend otherwise. IdP-initiated
SAML stays behind `allowIdpInitiated`, unchanged.

### 5. Dev-grade secrets are named at boot and refused on a deployed box (AUTHZ-05, CFG-03)

The compose defaults `dev-bootstrap` and `aaaa…` are printed in the public repository; the first
is a full admin with no identity on every route, exempt from the IP envelope by design, and the
boot log said nothing about either. `assessDevSecrets` runs after the data-key gate: the posture
block always prints `bootstrap: CONFIGURED / not configured` (and "a real admin already exists"
when the token has done its one job) and one `secrets: DEV-GRADE` line per finding. On a box
that shows a sign of being deployed — `REGULAIT_DEPLOY_MODE` set (install.sh writes it) or
`REGULAIT_HSTS` set — the published values and a key with fewer than eight distinct hex
characters **refuse the boot** as `DevSecretsBootError`, printed like the data-key refusal, with
`REGULAIT_ALLOW_DEV_SECRETS=1` as the stated override. A *short* token warns and never refuses:
CI's `e2e-bootstrap-token` and the README's laptop path keep booting. The plain
`docker compose --profile tls up` path still sets neither signal and therefore still boots on
the defaults, loudly; closing that gap is a compose/README decision, named in INSTALL.md.

### 6. A self-reported check result is stamped, reasoned, audited and badged (AUTHZ-06)

`POST /v1/workflows/instances/:id/checks` admits the initiator, so the person a check stage gates
could declare `security_scan: passed` and advance their own change with nothing in the context or
the trail distinguishing that from CI — and the workspace shipped a one-click `mark passing`
button that did exactly that. Still permitted (the demo, the seed and a team without CI report by
hand), never silent: every stored result carries `reportedByUserId` and `selfReported`; a
self-reported **pass** requires a `reason` (`check_report_reason_required` otherwise — reporting
your own *failure* needs none); the self-report is an audit row
(`workflow:checks-self-reported`); the evaluated result carries the stamp into the rail and the
approval view, which render a `self-reported` badge. The `mark passing` button asks the initiator
for the reason and stays disabled without it; an arm's-length admin keeps the one click. A
distinct CI identity (a virtual-key purpose or a per-connection secret) is the right follow-up,
not a prerequisite.

### 7. The parser's own refusals are reported as what they are (SEC-03)

Fastify's 413/400/415 (`FST_ERR_CTP_*`) fell through to `500 {"error":"internal"}`, reachable
unauthenticated, and the two import routes advertised bounds (2 MB / 4 MB) above the 1 MiB global
body limit, so their honest "payloads are bounded at N bytes" refusals could never fire. The error
handler maps any `FST_ERR_*` with a 4xx `statusCode` to that status and a snake-case code —
scoped to the prefix so a third-party error carrying a `statusCode` is never echoed — and the
import routes (`/v1/shadow-ai/imports`, `/imports/raw`, `/v1/cost-imports`, `/roster`) raise their
own `bodyLimit` to the advertised bound plus slack.

### 8. The OTLP collector headers join the envelope (SEC-06, migration 0128)

`org_settings.tracing_otlp_headers` held the collector's auth headers — conventionally an API key
— as plaintext jsonb, outside `CIPHERTEXT_COLUMNS`, the custody probe and the rotation walk, and
copied verbatim into the hash-chained audit row every settings update writes. Migration 0128 adds
`tracing_otlp_headers_ciphertext`; the write envelopes the map (503 `no_data_key` rather than
plaintext without a key), the jsonb column keeps only header *names* with every value the
`[redacted]` marker (so the settings screen still lists them), the export decrypts at the one
moment the values leave, a boot-time backfill envelopes a pre-0128 row once, and the column is in
`CIPHERTEXT_COLUMNS` (the custody drift test forces that). The jsonb column is dropped by a later
migration once every deployment has booted past this one.

### 9. The serving process logs, and never a credential (CFG-02)

`buildApp` ran with `logger: false`, so every `app.log.*` was a no-op and a 500's reason was
discarded unless an undocumented `DEBUG_ERRORS` was set. The logger is resolved on the boot path
(`gateway-logger.ts`, pino as shipped with Fastify — no new dependency), forced off under vitest,
with `authorization`, `cookie`, `x-api-key` and `set-cookie` redacted. Fastify's own per-request
lines (`incoming request` / `request completed`) are disabled: they print the full URL at info, which
for the OIDC callback is the authorization code and state — the review caught this live, and the
logger test now proves no line at info carries a query string. Every 4xx is one `warn`
line with route, method, IP and credential *kind*, every 5xx an `error` line; `LOG_LEVEL`,
`REGULAIT_LOG=off` and `DEBUG_ERRORS` are documented in INSTALL.md; compose caps the file.

### 10. The pool is bounded and /health cannot hang (CFG-08)

`new pg.Pool({ connectionString })` meant ten clients and a wait-forever for the eleventh.
`createDb` now reads `REGULAIT_DB_POOL_MAX` (20), `REGULAIT_DB_CONNECT_TIMEOUT_MS` (5000 — in
node-postgres this bounds both the connect and the wait for a free client), the idle reap (pg's
own 10 s, restated), and `REGULAIT_DATABASE_SSL` (`off|require|no-verify`); the posture block
prints them. `/health` races `select 1` against a 2 s deadline and answers `503 degraded` rather
than queueing behind an exhausted pool. No statement timeout on the pool, deliberately:
migrations, the re-encryption walk and backup verification share it.

### 11. The image and the stack (CFG-07, SEC-02, CFG-05)

The base image is pinned by digest; the serving process is `USER node` owning only the
audit-anchor buffer; the image carries a `HEALTHCHECK` (Node's fetch against `/health`, the image
has no curl) and compose restates it; `db`, `gateway` and `minio` carry `restart: unless-stopped`
in the compose file itself (it lived only in the dev box's user-data, so a customer install stayed
down after its first reboot); `.dockerignore` drops test and e2e code. `@xmldom/xmldom` is pinned
to 0.8.15 via `pnpm.overrides` — the one runtime-reachable HIGH advisory (quadratic parsing under
the auth-exempt ACS; measured 7.6 s at 80 k bytes on 0.8.13, 17 ms at 160 k on 0.8.15) — and the
ACS body is capped at 256 KiB + slack. The remaining HIGH advisories were each traced to an
unreachable or dev-only path and are left to a separate upgrade batch (PENDING S4).

**Amendment 2026-10-03.** CI's `docker build` — the verification this ADR named for the image
change — failed on the first push: dropping `*.test.ts` from the image removed the only path by
which `packages/git-provider` had resolved `@types/node` (a test file's `vitest` import), so the
image build lost `Buffer` and `fetch` while every local build, tests present, stayed green. Fixed
by declaring `@types/node` in every workspace package that compiles Node code, and proven with a
Docker-shaped rebuild (tracked files only, `.dockerignore` applied by hand, frozen install,
`pnpm -r build`). The `.dockerignore` stands. Ledger entry: `mistakes.md` M-063.

## Consequences

- **Behaviour changes an operator can see:** a Snowflake connector with no `baseUrl` needs an
  allow entry for its account host; a Teams/Outlook connector with a typed login host needs one
  for that host; a deployed box on the published secrets refuses to boot; the initiator of a
  change must give a reason to mark their own check passing; authenticated API traffic costs two
  counter upserts per request instead of one.
- **Not done here, named:** the plain compose `--profile tls` path still boots on the defaults
  (loudly); the SAML browser binding does not exist over plaintext http; the remaining
  `pnpm audit` HIGHs and a CI audit gate wait for the upgrade batch; the Docker image was changed
  without a local build (no daemon in this session) and is verified by CI's `docker build`.
- **Every fix has a negative control.** Each new test was run against the reverted file and went
  red before the fix was restored byte-for-byte; the rotated-bearer, credential-derived-host,
  list-scoping, parser-error, envelope, dev-secrets, browser-binding, self-report, pool and
  logging proofs all have one.

**Amendment 2026-10-03 (REL-01 widened, AER-035/037).** REL-01 guarded only IDLE pooled clients; a backend
dying under a CHECKED-OUT client was still an unhandled `error` that crashed the serving process. `createDb`
now attaches a per-connection `error` listener on `connect` that speaks only while the client is checked out
(tracked through the pool's `acquire`/`release`), so an idle drop logs exactly one line, the idle one
(`e5982a2`, `f3b4211`; process-lifecycle test "a CHECKED-OUT connection dying is logged, not fatal"). The MCP
health-probe claim is now serialized by `pg_advisory_xact_lock(6_000_000_037)` in a short transaction before
its `FOR UPDATE SKIP LOCKED … RETURNING` claim — `skip locked` alone let a claim whose snapshot predated
another claim's commit re-claim its rows (`79b0d3d`). Advisory-lock keys in use: 6_000_000_037 (health-probe
claim), 6_000_000_060 (audit chain).

## Amendment 2026-10-03 — a check nobody reported is pending, never passed (AER-047, PENDING L1)

**Why here.** §6 (AUTHZ-06) made a *self-reported* check result stamped, reasoned, audited and
badged. It said nothing about *absence*, and absence was the bigger hole: the check executor
(`apps/gateway/src/workflows.ts`) fell back to a deterministic offline auto-pass whenever a named
check had neither an eval outcome nor a reported result, and `workflow-checks.test.ts` pinned that
as the contract. A merge gate approved before CI posted advanced with every check "passed"; a
`failed` security scan posted afterwards was refused as late. Same rule as the rest of this ADR —
the stage now reports the thing the caller cannot choose: what was actually reported. Codex raised
it as AER-047 (HIGH); the owner's recorded recommendation (b) in PENDING L1 is what shipped. This
supersedes the 2026-07-28 "workflow depth" behaviour recorded in `STATE.md` ("falling back to the
deterministic auto-pass when none are reported").

**1. The default is pending** (`6477266`). A named check with no eval outcome and no report is
`pending`. A reported failure still blocks at once (`check_failed` → `blocked_on_check`) even while
other checks are missing. Otherwise any pending check leaves the instance at
**`awaiting_execution` on that check stage**, claim released, and writes a
`workflow:checks-awaiting-report` audit row naming `missingChecks`. A retried `/advance` (the
lost-callback or timeout case) re-evaluates and waits again; the kernel refuses a `human_trigger`
on a stage with named checks ("runs named checks and cannot be human-triggered").
*Why `awaiting_execution` and not `blocked_on_check`:* `POST .../checks` already re-evaluates a
stage that is `awaiting_execution`, so CI's next report picks it up with no human step;
`blocked_on_check` means a check *failed* and needs a manual recheck, which would both misdescribe
silence and add a click to the normal CI path.

**2. The only way back to auto-pass is a typed, fail-closed opt-in.**
- `offlineAutoPass: boolean` on an `automated_check` stage (`f734abd`, `packages/workflow-kernel`),
  refused on any other stage type and on a check stage with no named checks; a non-boolean is
  rejected, not coerced. (The stage schema used to strip the key silently.) No migration —
  templates are stored JSON.
- It is honoured only when the process **positively declares** `REGULAIT_OFFLINE_CHECKS=1`
  (exactly `1`) **and** shows no deployed signal — §5's `networkFacingSignal`,
  `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` set (`offlineAutoPassRefusal`, `6079d47`). The first
  cut honoured it whenever no deployed signal was present; review showed that fails open, because a
  bare `docker compose --profile tls up` on a public host sets neither signal (§5 says the same).
  Absence of a signal never grants the opt-in; it only narrows it. A refused opt-in leaves the
  checks pending and the `checks-awaiting-report` row carries `offlineAutoPassRefused`,
  `refusedBecause` and, when that is the reason, `deployedSignal`.
- The demo declares it explicitly: the seeded `complete-pipeline` and `deploy-verify-pipeline`
  check stages set `offlineAutoPass: true`; `seed.ts` sets `REGULAIT_OFFLINE_CHECKS ??= "1"` for
  its own in-process app only (an explicit `0` is respected); the presenter's gateway exports it
  per DEMO_SCRIPT §0 and DEMO_RUNBOOK §1 (`d9b01fc`). Gallery and admin-starter templates get the
  pending default.

**3. Labelled and audited wherever surfaced.** Each auto-passed result carries `autoPassed: true`
and the detail "auto-passed — no report (offline mode)", and gets a `workflow:checks-auto-passed`
audit row. The workflow rail shows an "auto-passed · no report" badge; the Inbox merge-gate view
colours auto-passed and pending checks as warnings, never CI's green, and says how many checks had
no reported result; a stage waiting at `awaiting_execution` names the missing checks instead of
claiming a run is in flight (`2542ae2`).

**4. Results belong to their round** (`6079d47`). When a resubmitted artifact re-opens the flow,
the `reported:`, `checks:`, `evals:` and `awaitingReport:` context keys of every downstream
`automated_check` stage are cleared in the same locked transaction, and the
`workflow:artifact_submitted` row lists `staleCheckResultsCleared` — a re-run check stage never
reuses the previous round's green. Reports posted before the stage runs are still accepted within
a round (the seed and suites rely on it).

**5. Evals.** Eval-bound checks run once per stage entry and the outcome is reused while the stage
waits; a recheck from `blocked_on_check` and a re-open re-run them; a failing eval still blocks at
once. An eval-bound check that produces no outcome is `failed` — a gate that could not run does not
pass (ADR-0044) — and is never auto-passed, even under the opt-in. One `checks-awaiting-report`
row is written per distinct waiting state (missing set plus refusal reason), not per
re-evaluation.

**Evidence.** `workflow-checks.test.ts` 13 (no-report wait with one row after two retries, partial
report, explicit pass, explicit fail under and without the opt-in, never-declared, `DEPLOY_MODE`
and `HSTS` refusals, re-open), `eval-harness.test.ts` 23 (incl. eval reuse while waiting), kernel
45 (4 new), `seed.test.ts` 8; 45 workflow-related gateway files 657/657 on a fresh database.
Negative controls: `workflows.ts` reverted fails 13 of 36 across workflow-checks and eval-harness;
removing the declaration requirement, the re-open clearing, the waiting-row dedupe, the eval
reuse, the kernel `human_trigger` guard or the seed's declaration each turns a named test red.
`e137fdf` makes the opt-in tests clear `REGULAIT_OFFLINE_CHECKS` up front, so the suite also
passes from the demo terminal that exports it.

**Honest limits.**
- No wall-clock timeout: a missing report stays pending indefinitely.
- The seed declares `REGULAIT_OFFLINE_CHECKS` for its own in-process app, and the container runs
  `seed.js` first when `SEED_DEMO=1` (the compose default). On a bare `docker compose` deploy the
  seeded demo `deploy-verify` instances are therefore auto-passed, labelled — demo fixtures and
  mock providers only; the serving gateway still refuses every template's opt-in unless declared.
- Narrow race, plausible, not reproduced: the check executor holds the context in memory across
  eval calls and writes it back unlocked, so a resubmission that re-opens the flow during a
  running eval could restore stale round-1 check keys (the same lost-update shape can drop a
  concurrent `POST .../checks` report).
- A previous-round CI report that arrives after a re-open counts for the new round; the report
  API carries no artifact version.
- Pre-existing, outside AER-047: a re-open does not drop the build stage's `runId`, so a
  re-entered build replays v1's nested run — the checks are bound to the round, the build they
  gate is not.

## Amendment 2026-10-03 — a check result belongs to the round it was produced in (AER-048)

**Why here.** The AER-047 amendment's honest limits named two holes it did not close: the check
executor held the instance context in memory across eval calls and wrote it back unlocked (a
concurrent `POST .../checks` report could be dropped, and a re-open during a running eval could be
rolled back to round-1 check keys), and a previous-round CI report that arrived after a re-open
counted for the new round. Codex raised the first as AER-048 (HIGH, direct source observation at
`dbbb642`). Same rule as the rest of this ADR: the stage commits only what the database says is
still current, not what the executor remembers. Fixed on `wt-aer48`, merged at `7a40d77`.

**1. Two durable tokens** (`a0f0d85`, migration 0130). `workflow_instances.round` is bumped on every
re-open (an artifact resubmitted after its stage completed; a sign-off returned via the kernel event
`approval_returned`, ADR-0168). `workflow_instances.stage_entry` is bumped on every entry into an
executable stage — including a recheck — and on every re-open. They are columns, not context keys,
so no context write, stale or otherwise, can roll a token back. Existing instances start at 0.

**2. Executor completion is a locked compare-and-set** (`be1f3d9`). The executor captures the
stage entry with its claim; completion goes through `commitStageResult`, which re-reads the row
`FOR UPDATE` and commits only if the stage entry, the stage, `awaiting_execution` and its own claim
id are all still current, merging only the context keys the executor itself changed. Otherwise the
result is discarded and audited `workflow:executor-result-discarded`; effect records the discarded
run produced are salvaged under the same lock and their values are carried in the audit detail
(`26bfb09`). The stage span is written after the commit. Nested-run completion has the same
precondition, and a re-open clears `runId:<stage>` for build stages after the re-opened one, so a
run planned in an old round never satisfies the new one (closing the AER-047 "pre-existing"
limit). Every workflow external provider write is its own `external-effect:<operation>` audit
row. The reclassification reapply path takes the same instance row lock (`f54f0a0`).

**3. Reports bind to the round, and fail closed** (`be1f3d9`, `26bfb09`). `POST .../checks` takes
a `round`. A key-authenticated caller (API key, virtual key, bootstrap — i.e. CI) that omits it is
refused `422 round_required`, unless the org setting `checkReportsAllowUnbound` is on (default
false, admin-only, its change audited). A session-authenticated caller (a person in the console)
may omit it and binds to the round current when the report is applied. A report naming any other
round is `409 stale_check_report`, audited `workflow:checks-report-stale-round`. A report that
lands while another executor holds the claim is stored and answered `202
deferred_to_running_executor`; the claim holder re-evaluates once if reports changed during its
run and it did not commit. The PR body carries `regulait-instance:` and `regulait-round:` lines
naming the round the PR was opened in (see the limits: it goes stale after a re-open). *Fail closed was the dispatcher's choice over "omitted means
current"*: an unbound CI report is exactly the stale-round case this amendment exists to stop.

**Evidence.** `workflow-check-round.test.ts` 10/10: (1) a report posted while the executor is
mid-eval is retained and decides the verdict; (2) a re-open during the eval can neither restore
the cleared keys nor advance the instance; (3) a previous-round report is 409 and audited, the
current round (explicit or, from a session, omitted) is accepted; (3b) a CI report naming no round
is 422 unless the org opts out; (4) a lapsed executor's late result is discarded — the kernel
outcome is applied once and the context is not rolled back; a no-race control; (5)/(6) a
discarded deploy/merge keeps its effect record; (7) an executor that throws after a report arrived
re-evaluates once; (8) a re-open clears a later build's `runId`. A negative control per fix. Full
suite 3367 passed on the implementer's run, and the dispatcher's full gate on the merged tree (`7a40d77`) then passed: fresh-database suite 3367 passed / 9 skipped, demo:prepare 18/18, real demo journey 1/1, mocked UI suite 54/54, phase1+phase2 journeys 39/39, approval-review 4/4, fallback deck built. Two independent adversarial reviews: round 1 fix-first (8 findings, fixed in
`f54f0a0` and `26bfb09`), round 2 ship.

**Honest limits.**
- Round tokens make the stage's kernel outcome apply once and keep the context from rolling back;
  they cannot un-perform an external effect a lapsed executor makes after a TTL re-take — that
  effect may be repeated, visibly, as a second `external-effect:*` row (pre-existing).
- **AER-049 (owner decision, PENDING):** effect records (`deploy:<stage>`, `mergeSha`, `prId`,
  `branch`) survive a re-open, so after a re-open past merge or deploy the new round re-runs the
  build but skips merge and deploy, and the instance can complete as merged/deployed when only v1
  shipped. Tests (5) and (6) currently assert that skip.
- The echoed `currentRound` is a plain integer, so a naive CI can resend it and pass the binding;
  an opaque per-round token would stop that.
- The PR body's `regulait-round:` goes stale after a re-open; CI should `GET` the instance's
  `round` at run start rather than trust the PR body.
- A live old-round nested run is not aborted on re-open (its completion is refused, its work is
  not stopped).
- A hard crash after a `202 deferred_to_running_executor` still waits out the claim TTL before the
  stage is re-taken.
- An `applyEvent` precondition-write hazard was noted in review; safe with today's callers.
