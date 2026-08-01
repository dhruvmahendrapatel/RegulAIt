# ADR-0031 — P0/P1 hardening: streamed bounded exports, cursor-paged audit reads, narrowed proxy trust, HTTP rate limits, gateway security headers, and observable schedulers

- **Status:** Accepted
- **Date:** 2026-08-01
- **Corrects:** ADR-0029 (`trustProxy: true`, and its assessment of `requestIsSecure()`) — see §3.
  The dated amendment is appended to ADR-0029 itself.
- **Extends:** ADR-0021 (org-settings configurability — with a stated shortfall), ADR-0022
  (the audit CSV export), ADR-0025 (per-account login lockout), ADR-0026 (the SPA the gateway
  serves), ADR-0027 (the backup-verification scheduler)
- **Migrations:** none. Deliberately. Every fix here rides existing columns; the two places
  where a column *would* be the right home are named as follow-ups rather than smuggled in.

## Context

An adversarial audit of the gateway found six defects that share one property: each is invisible
until the day it matters, and each contradicts something the product explicitly sells. Three of
them (unbounded exports, blanket proxy trust, no rate limiting) are the kind of thing a customer
security review finds before we do.

## Decision

### 1. Every CSV export streams, in keyset batches, under disclosed bounds (P0)

`/v1/audit.csv`, `/v1/projects/:projectId/costs.csv` and `/v1/usage-events?format=csv` each did a
full-table `select()` with no limit and no date bound, materialised every row into a JS array,
and concatenated one giant string before Fastify ever saw it. `audit_log` grows a row per
governed call and ADR-0021's auto-prune ships OFF by default, so the memory cost of the audit
export is unbounded in the one table guaranteed to grow forever. That is an OOM of the gateway
container, triggered by an admin clicking "export".

All three now route through one implementation (`apps/gateway/src/csv-export.ts`):

- **Keyset, not OFFSET.** Pages walk `(at DESC, id DESC)` with a row-wise
  `(at, id) < ($1::timestamptz, $2::uuid)` predicate. OFFSET would still scan everything it
  skips, so deep pages degrade linearly; a keyset seek does not.
- **Microsecond-exact cursors.** `timestamptz` stores microseconds; node-postgres hands
  JavaScript a millisecond `Date`. A cursor built from that truncated value silently DROPS every
  row whose sub-millisecond component fell between the truncated and the true value. The cursor
  therefore carries the value rendered in SQL
  (`to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) and compares against that
  text cast back to `timestamptz`. Proven against five rows sharing one instant.
- **Streamed.** `reply.hijack()` + one `reply.raw.write()` per batch, with real backpressure
  (await `drain` when `write()` returns false). Peak memory is one batch.
- **Bounded, and the bound is DISCLOSED.** A default 90-day window
  (`REGULAIT_CSV_WINDOW_DAYS`, `0` disables) and a 500,000-row ceiling
  (`REGULAIT_CSV_MAX_ROWS`); batch size `REGULAIT_CSV_BATCH_ROWS` (default 2000). Every response
  carries `x-regulait-export-row-limit`, `x-regulait-export-window-source`
  (`caller|default|unbounded`) and the applied `…-window-from` / `…-window-to`. When the file is
  **not** the complete answer — the ceiling was hit, or the *defaulted* window excluded rows that
  actually exist — a trailing single-field comment row says so in the file itself, names the
  window, and tells the caller how to fetch the remainder. A compliance export is never silently
  short.
- **Byte-identical when complete.** The header row (including PR #79's `deployMode` column, which
  writes the literal word `unknown` for a null rather than an empty cell), field order, escaping
  and line terminator
  (`\n` for the audit export, `\r\n` for the usage exports) are unchanged, and the notice row is
  emitted only when something was actually clipped — so a complete export is byte-for-byte what
  the old code produced. A test asserts the streamed body equals the retained non-streaming
  `usageEventsCsv()` renderer over the same rows.
- **Mid-stream failure is disclosed too.** The status line is already on the wire by then, so
  the only honest option left is to write the failure into the file and end.

`hasRowsOutsideWindow` is a one-row existence probe, not a count — the disclosure must not cost
another full scan.

**Proven empirically, not by inspection.** The tests count the SQL round trips the route makes
(by intercepting `db.select`) and assert that the same export costs strictly more queries at a
batch size of 2 than at a batch size large enough to hold everything, while returning an
identical body.

### 2. The audit read surface pages (P1)

`/v1/audit` was `.limit(100)` with a single `userId` filter, no offset, no cursor, no date range.
On a compliance product, no admin could ever see row 101; the only escape was the CSV download.

It now takes an opaque base64url keyset `cursor` over the same stable `(at DESC, id DESC)` sort
and the same microsecond-exact encoding, plus `from`/`to`/`objectType`/`effect` filters beside
`userId` and PR #79's `deployMode`. The final filter set is
`userId, deployMode, objectType, effect, from, to` (+ `limit`/`cursor` on the screen read only),
declared **once** as `auditFilterQuery` — the screen read extends it with paging, the export takes
it unchanged — and turned into a predicate **once** by `auditFilters()`, which subsumes PR #79's
`auditWhere`. A filter can therefore never be added to one surface and silently skipped by the
other; a test walks a matrix of filter combinations and asserts the two endpoints select
row-for-row identical sets, that the four `deployMode` buckets partition the trail with nothing
lost or double-counted, and that an unknown mode is a 400 on both rather than an ignored param. `limit` defaults to **100** and is capped at a documented **1000**
(`AUDIT_MAX_PAGE_SIZE`). The response adds `pageSize`, `maxPageSize`, `hasMore` and `nextCursor`
alongside the unchanged `entries`, so every existing caller (the SPA, the legacy portal, ~40
tests) sees exactly the previous behaviour. A tampered cursor is a **400**, never a silent
restart of the walk from the top — silently restarting would let a paginating export loop
forever or, worse, appear complete while repeating page one.

### 3. `X-Forwarded-*` is trusted only from a named proxy — correcting ADR-0029

`req.ip` is what lands in `auth_sessions.ip` and in the attribution record pillar 1 sells.
Trusting `X-Forwarded-*` from any peer means anything that can reach the gateway port — the host
loopback, a sibling container on the compose network, a future sidecar — can choose the client IP
that appears on the compliance trail and can claim an `https` origin over a plaintext hop.

Fastify is now configured with an explicit `trustProxy` resolved from **`REGULAIT_TRUSTED_PROXIES`**:
a comma-separated list of IPs, CIDRs or `proxy-addr` keywords (`loopback`, `linklocal`,
`uniquelocal`); `none`/`off`/`false`/empty for nothing; `all`/`true` only when an operator asks
for the wide-open behaviour **by name**.

**Deployed value: `172.28.0.2` — Caddy's address, and nothing else.** `docker-compose.yml` now
declares an explicit network with a pinned subnet (`172.28.0.0/16`) and gives the `caddy` service
that fixed address, purely so the trusted peer can be *named* rather than approximated by a subnet
that would also cover the `db` container. Host loopback is deliberately **not** trusted: the
gateway port is published there (`127.0.0.1:3000:3000`) for the README entry point and the on-box
SSM `curl localhost:3000` verification, and both of those bypass Caddy. With the `tls` profile off
the address simply does not exist, so nothing is trusted and `req.ip` is the socket peer — one
value works for both profiles.

No Terraform change was needed: `infra/modules/app-instance`'s user-data override only injects the
per-deployment secrets, so the compose file's value flows through unchanged. Putting it in both
places would be two things to keep in sync.

**Default when the variable is unset: trust nothing.** That is the right default for anyone
running the gateway *without* a terminator — laptop, CI, `docker run`, a BYOC install — where any
believed `X-Forwarded-*` is by definition unverifiable. The deployed path is correct because the
compose file sets the variable, not because the default guesses. `main.ts` prints the effective
posture at boot, so the failure mode of getting it wrong is an obviously-wrong IP an operator
notices rather than a plausible IP anyone on the network can choose.

Tested in both directions: a forged `x-forwarded-for` from an untrusted peer does not win (nor
does a forged full chain naming the proxy), a genuine hop from the trusted proxy does, and the
trusted-proxy app still ignores the header from any other peer.

**`requestIsSecure()` is fixed in the same breath.** ADR-0029 assessed the raw-header read as safe
because forging `x-forwarded-proto: https` can only turn the session cookie's `Secure` flag *on*.
That is the harmless direction. The same ungated read also accepts `x-forwarded-proto: http` from
anything that reached the port without passing through Caddy — and *that* issues a session cookie
with **no** `Secure` flag, which a browser will then send in cleartext. It now returns
`req.protocol === "https"`, Fastify's own trust-gated answer: the header is consulted only for a
peer matching `trustProxy`, otherwise the real socket protocol wins.

Two deliberate consequences, both tested. A multi-hop `x-forwarded-proto` is now read as the
**last** entry (the nearest, trusted hop) instead of the first — the first is exactly the entry a
client can inject when an upstream appends rather than overwrites, and our Caddy sends a single
value so no chain arises in this topology. And a deployment behind a terminator **must** name it
in `REGULAIT_TRUSTED_PROXIES` or `Secure` turns off; the compose file sets it and boot logs the
posture precisely so that cannot happen quietly. ADR-0029's regression wall is kept and extended
to assert every case from *both* sides of the trust boundary.

### 4. HTTP rate limiting (P1)

There was a per-**account** login lockout (ADR-0025) and nothing else: no bound on per-IP or
per-key request rates on any of the ~167 endpoints. Credential spraying that touches each account
once is invisible to a per-account lockout.

**Dependency justified:** `@fastify/rate-limit` (v11), the maintained first-party plugin. It is
in the same org as the framework, has an in-process store that needs no Redis for the
single-container topology, and swaps to a Redis store unchanged if the gateway is ever scaled
horizontally. The alternative was hand-rolling a token bucket with its own clock, eviction and
header semantics — not worth owning.

Three buckets, all keyed on the **real** client IP:

| bucket | key | default |
|---|---|---|
| credential endpoints (`/auth/login`, `/auth/mfa/verify`, `/auth/login-with-key`) | `auth:<ip>` | 10 / 5 min |
| bearer-credential callers | `key:<first 32 chars>` | 6000 / min |
| everything else | `ip:<ip>` | 1200 / min |

The API-key bucket exists so a legitimately busy service account behind one NAT is neither
throttled by nor able to exhaust its neighbours' allowance. `/health` is allow-listed so a
liveness poll is never read as an outage.

**This depends on §3.** Under a blanket `trustProxy` an attacker rotates `x-forwarded-for` and
gets a fresh bucket per request, which makes the limiter decorative. A test asserts exactly that:
a forged header buys the sprayer nothing.

The plugin is registered `global: false` and driven from our own `onRequest` hook. Its `onRoute`
integration only sees routes registered *after* the plugin finishes loading, and `register()`
defers that to `ready()` — long after every route is in place. Driving it from a hook added
before any route makes coverage order-independent rather than dependent on registration order.

**STOP / stated shortfall.** Under ADR-0021's admin-configurability mandate these limits belong
in `org_settings`, beside `login_lockout_threshold`. `org_settings` has **no** rate-limit columns
today, and this batch deliberately adds no migration, so the values live in constants with env
overrides (`REGULAIT_RATE_LIMIT`, `…_MAX`, `…_WINDOW_MS`, `REGULAIT_AUTH_RATE_LIMIT_MAX`,
`REGULAIT_AUTH_RATE_LIMIT_WINDOW_MS`, `REGULAIT_API_KEY_RATE_LIMIT_MAX`). **Follow-up:** add
`http_rate_limit_max`, `http_rate_limit_window_seconds`, `auth_rate_limit_max`,
`auth_rate_limit_window_seconds`, `api_key_rate_limit_max` to `org_settings` and read them
through `loadOrgSettings`, so an admin can tune them without a redeploy. Until then this is a
disclosed deviation from the ADR-0021 convention, not an oversight.

**Test posture, disclosed:** the gateway suite runs with `REGULAIT_RATE_LIMIT=off`
(`vitest.config.ts`) — it drives thousands of requests from one address in seconds, and
`auth.test.ts` deliberately fails login dozens of times to exercise the ADR-0025 lockout.
`rate-limit.test.ts` builds its own app with the limiter explicitly ON, and separately asserts
that the config resolved from an **empty** environment is `enabled: true`, so the shipping
posture is covered rather than assumed.

### 5. Security headers, from the gateway itself (P1)

The gateway serves the SPA and is directly reachable (the compose port, every dev machine), and
emitted no CSP, `X-Content-Type-Options`, `X-Frame-Options` or `Referrer-Policy`. Added via an
`onSend` hook in `app.ts` — not `web-serving.ts`, because they belong to every response, not just
static files.

**Set-if-absent, never overwrite.** A route (or an edge proxy) that already chose a value keeps
it, so the hook cannot produce a conflicting duplicate — the `nosniff` `web-serving.ts` already
sets on assets stays exactly one header.

Two policies, selected by response content-type:

- **documents:** `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
  form-action 'self'; script-src 'self' <sha256 hashes>; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;
  manifest-src 'self'`
- **everything else** (JSON, CSV, JS/CSS assets): `default-src 'none'; base-uri 'none';
  frame-ancestors 'none'`

Plus, on both: `x-content-type-options: nosniff`, `x-frame-options: DENY`,
`referrer-policy: no-referrer`, `cross-origin-opener-policy: same-origin`,
`cross-origin-resource-policy: same-origin`, and a `permissions-policy` that denies camera,
microphone, geolocation, payment and USB.

**`script-src` takes no `'unsafe-inline'`.** The SPA's `index.html` carries an inline theme
pre-paint script (it prevents a flash of the wrong theme, and it is in `apps/web`, which this
change does not own), and each deprecated `/legacy/*` shell carries an inline script. All three
are **hashed at boot from the exact bytes that will be served** — the legacy HTML constants in
memory, and `apps/web/dist/index.html` read from disk — rather than hardcoded. A rebuilt Vite
bundle (new hashed asset filenames) or an edited pre-paint script therefore keeps working with no
constant to drift.

**Disclosed relaxation:** `style-src` keeps `'unsafe-inline'`. The legacy shells carry large
inline `<style>` blocks and 180-odd inline `style="…"` attributes; adding a hash source would
make the browser *ignore* `'unsafe-inline'` and break them outright. React does not need it — it
sets styles through CSSOM, which CSP does not govern — so **follow-up:** tighten `style-src` to
`'self'` in the release that removes `/legacy/*`.

**HSTS** is set only on a genuinely secure request. Announcing it over the plaintext dev hop
would be wrong, and per §3 "secure" now means a real TLS hop or one from a trusted proxy, never a
forged `x-forwarded-proto`.

**Verified against the real built bundle**, not by inspection: `/ui` is served, every inline
script in the served document is covered by a hash in the emitted `script-src`, every external
script/stylesheet is same-origin (so `'self'` covers it) and really resolves 200, and the
streamed CSV export carries the headers too despite `reply.hijack()` bypassing `onSend`.

### 6. Scheduler failures are observable (P1)

The ADR-0021 audit auto-prune and the ADR-0027 backup verification both swallowed every failure
in a bare `catch { }`. On a product whose pitch is that nothing happens unobserved, a backup
verification failing for months looked exactly like one that was switched off.

Three channels, ordered by how likely each is to survive whatever broke:

1. a **console log** — always, first, before anything that could itself fail;
2. an **in-memory health record** per scheduler at `GET /v1/health/schedulers` (admin-only) with
   `lastRunAt`/`lastSuccessAt`/`lastFailureAt`/`lastError`/`runs`/`failures`/
   `consecutiveFailures`/`healthy`. In-memory on purpose: it still answers when the **database**
   is what broke, which is the likeliest reason a tick failed;
3. an **audit row**, best-effort and deliberately last, under its own rule id
   (`audit-prune-failed` / `backup-verify-failed`), with `effect: 'deny'` (the scheduled act did
   NOT happen) and the same `objectType` as the matching success row so one filter finds both. If
   the database is the failure, this write fails too — and it must not be able to mask the log
   and the health record, which is why it runs last and its own failure is logged.

Deliberately **not** folded into `/health`: a liveness probe must not start failing because a
verification pass errored, but an admin must be able to see that it did. The empty-list case
says so in the payload rather than letting a dashboard render a green tick for "never ran".

Each tick body is extracted to an exported `auditPruneTick` / `backupVerifyTick` so tests can
drive a real tick instead of waiting an hour; the timers are the only other callers and their
behaviour is unchanged. No migration — the failure marker rides existing `audit_log` columns.

## Consequences

- Peak memory for the audit export is one batch instead of the whole table; the export is now
  resumable by date window rather than all-or-nothing.
- Callers of `/v1/audit.csv` and `/costs.csv` that pass no date bound now get the last 90 days,
  with the truncation stated in the file and the headers. This is a behaviour change, chosen over
  the alternative (an OOM) and over making the bounds mandatory (which would break every existing
  caller silently).
- A deployment behind a reverse proxy MUST set `REGULAIT_TRUSTED_PROXIES` or every request will
  be attributed to the proxy. Boot logs the effective posture.
- One new runtime dependency: `@fastify/rate-limit`.
- The gateway's own test suite runs with rate limiting off; see §4 for why and what covers the
  shipping default instead.

## Known gaps and follow-ups (stated, not hidden)

1. **`org_settings` rate-limit columns** (§4) — the natural home under ADR-0021, blocked only by
   this batch's no-migration constraint.
2. **`style-src 'unsafe-inline'`** (§5) — tighten to `'self'` when `/legacy/*` is removed.
3. ~~`requestIsSecure()` reads `x-forwarded-proto` directly~~ — **CLOSED** in this branch (§3).
   It was deferred while `auth.ts` was owned by a parallel change; that change has landed and the
   fix went in with it.
4. **`infra/caddy/Caddyfile` sets no security headers** — it does `header_up` on the *request*
   side only, so there is nothing for the gateway's `onSend` values to conflict with today. The
   `onSend` hook is set-if-absent, so a header added at the edge later will win rather than
   duplicate; even so, two different CSPs on one response would be a bug, and whoever adds one at
   Caddy should delete or match the gateway's instead of layering.
6. **The trailing disclosure row is a consumer contract.** Anything that walks every CSV line and
   reads column N must skip it — `isCsvNoticeRow()` is exported from `csv-export.ts` as the one
   shared way to recognise it, and two pre-existing tests (`a4-mode-dimension`,
   `identity-lifecycle`) were updated to use it rather than have the notice masquerade as a data
   row. That is the price of never silently truncating a compliance export, and it is stated here
   rather than left for someone to discover in a parser.
5. ~~`worker-streaming.test.ts` hardcodes the database name `regulait_wt_stream`~~ — **FIXED**
   here. It drop-recreates that database `WITH (FORCE)`, so any second checkout running the same
   file terminated this one's connections: an unhandled `57P01` and, intermittently, a whole
   suite reported as failed with its 15 tests skipped. The scratch database is now derived from
   `DATABASE_URL` (`<caller's db>_stream`), which makes the isolation the file already intended
   actually hold. Pre-existing, unrelated to the six items, fixed because it otherwise makes
   every agent's verification run untrustworthy.

## Amendment recorded on ADR-0029

This branch forked before ADR-0029 landed, so the correction was first written here as a
ready-to-paste note. ADR-0029 has since merged and the dated amendment is now appended to
`docs/decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md` itself — its original decision text
untouched. It records both corrections (`trustProxy: true` narrowed to a named peer, and
`requestIsSecure()` moved onto the trust-gated `req.protocol`), the deployed value, and why
"trust nothing" remains the default for anyone running without a proxy.
