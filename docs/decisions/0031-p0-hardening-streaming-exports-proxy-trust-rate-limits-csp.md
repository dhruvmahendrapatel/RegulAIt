# ADR-0031 — P0/P1 hardening: streamed bounded exports, cursor-paged audit reads, narrowed proxy trust, HTTP rate limits, gateway security headers, and observable schedulers

- **Status:** Accepted
- **Date:** 2026-08-01
- **Corrects:** ADR-0029 (`trustProxy: true` — see §3 and the ready-to-paste amendment at the end)
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
- **Byte-identical when complete.** The header row, field order, escaping and line terminator
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
`userId`. `limit` defaults to **100** and is capped at a documented **1000**
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

**The chosen default is `false` — trust nothing.** Not the docker-bridge range, and not
loopback. Rationale: on the compose topology there is no reverse proxy in front of the gateway
today, so trusting the bridge or loopback would buy no correctness and would hand every sibling
container (and anything on the host loopback) exactly the forgery this change exists to remove.
A deployment that *does* put Caddy/nginx/an ALB in front must name it, and `main.ts` prints the
effective posture at boot. The failure mode of getting it wrong is then an obviously-wrong IP an
operator notices, rather than a plausible IP anyone on the network can choose — and it is
strictly safer than what shipped before.

Tested in both directions: a forged `x-forwarded-for` from an untrusted peer does not win (nor
does a forged full chain naming the proxy), a genuine hop from the trusted proxy does, and the
trusted-proxy app still ignores the header from any other peer.

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
3. **`requestIsSecure()` in `apps/gateway/src/auth.ts` still reads `x-forwarded-proto` directly**,
   unconditionally, regardless of `trustProxy`. That means the `Secure` flag decision on the
   session cookie can still be driven by a forged header even after §3. `auth.ts` was owned by a
   parallel change during this batch and was deliberately not touched. The one-line fix is to
   replace the header read with `req.protocol === "https"`, which Fastify derives from the
   trust-proxy setting §3 installed. **This should be the first follow-up.**
4. **No `infra/caddy/Caddyfile` exists on this branch**, so there was nothing to reconcile the
   gateway's headers against. When an edge proxy is introduced, it must either omit these headers
   or set the identical values — the `onSend` hook's set-if-absent behaviour means the gateway
   will not fight it, but two different CSPs on one response is still a bug.
5. **`worker-streaming.test.ts` hardcodes the database name `regulait_wt_stream`** and
   drop-recreates it, rather than deriving it from `DATABASE_URL`. Two agents running the suite
   concurrently kill each other's connections (an unhandled `57P01`). Pre-existing; noted here
   because it surfaces as a spurious suite error.

## Amendment to record on ADR-0029

ADR-0029 is not present in the tree this change branched from (`docs/decisions/` ends at 0028),
so the amendment could not be appended in place. The following dated note should be added
verbatim to the end of ADR-0029 when the two branches meet — ADR-0029's decision text itself must
not be rewritten.

> ### Amendment — 2026-08-01 (ADR-0031)
>
> The `trustProxy: true` this ADR introduced was **too broad**. It trusts `X-Forwarded-*` from
> any peer, so anything able to reach the gateway port directly — host loopback, a sibling
> container on the compose network, a future sidecar — could forge both the `https` origin and
> the client IP that lands in `auth_sessions.ip` and on the audit trail, which is the attribution
> record pillar 1 sells.
>
> Replaced by an explicit, narrow setting resolved from `REGULAIT_TRUSTED_PROXIES` (IPs, CIDRs or
> `proxy-addr` keywords), **defaulting to trusting nothing**. A deployment behind a reverse proxy
> must name that proxy; the effective posture is printed at boot. See ADR-0031 §3 for the full
> rationale, including why the docker-bridge range was rejected as a default.
