# ADR-0029 — Zero-cost TLS for the dev stack: Caddy + sslip.io + Let's Encrypt

- **Status**: Accepted
- **Date**: 2026-08-01
- **Relates to**: ADR-0013 (dev app deployment: one EC2 box running docker compose), ADR-0025
  (secure human auth — session cookies), ADR-0028 (session origin), pillar 1 (per-user governance
  and audit)

## Context

The dev/demo stack ([ADR-0013](0013-dev-app-deploy-single-ec2-compose.md)) serves the app over
**plain HTTP** on `http://3.237.199.248:3000`, with the security group opening `:3000` to
`0.0.0.0/0`. Since [ADR-0025](0025-secure-human-auth.md) that box carries real human
authentication: passwords, server-side sessions, an `HttpOnly; SameSite=Strict` session cookie.

Over cleartext HTTP that cookie is the whole authentication system travelling in the open. Worse,
its `Secure` attribute is *conditional on the request being https* — so on this deployment the one
flag whose job is "never send me over cleartext" has never once been set. Every login, every
session token, every API key pasted into the legacy shells crossed the public internet readable.
ADR-0013 disclosed "no TLS" as an accepted dev-grade risk; ADR-0025 changed what is at stake and
that risk stopped being acceptable.

The owner's constraints were explicit and narrow:

- **No new AWS cost.** An Application Load Balancer is ~$16–25/month before data processing.
- **No production move.** This stays a dev stack; the standing guardrail in `CLAUDE.md` applies.
- Implicitly: **no domain purchase** — ACM issues certificates for free but only for a domain you
  control, and controlling one costs money and creates a Route53 hosted zone ($0.50/month).

So the requirement is real, browser-trusted TLS with a $0 delta.

## Decision

**Terminate TLS on the instance itself, inside the existing compose stack, with a Caddy reverse
proxy that obtains a real Let's Encrypt certificate for an sslip.io hostname derived from the
box's public IP.**

Concretely:

### 1. Caddy in the compose stack, behind a `tls` profile

`infra/caddy/Caddyfile` serves `{$REGULAIT_TLS_HOST}` (default `3-237-199-248.sslip.io`) on
`:443` and reverse-proxies to `gateway:3000` over the compose network. Caddy's automatic HTTPS
handles issuance, the HTTP-01 challenge on `:80`, the 308 redirect from `:80`, and renewal — no
cron, no script, no human.

The service sits behind compose profile **`tls`**, so a bare `docker compose up` (the README
quickstart, any laptop, CI) does **not** start it. This is not tidiness: a laptop attempting ACME
for the box's hostname cannot pass the challenge, and every failure counts against Let's Encrypt's
5-per-hour failed-validation limit for that account/hostname. The box enables the profile via
user-data.

### 2. sslip.io for DNS — free, no registration, no Route53

[sslip.io](https://sslip.io) resolves `a-b-c-d.sslip.io` → `a.b.c.d` for any IP. That is a real,
publicly resolvable A record, which is all HTTP-01 needs. Nothing to buy, nothing to register, no
hosted zone. `user-data.sh.tftpl` reads the instance's public IPv4 from IMDSv2 at boot and writes
the derived hostname into `docker-compose.override.yml` — Terraform cannot pass it in, because the
public IP does not exist until the instance does.

### 3. A named volume for `/data` — the single most important operational detail

`caddy_data:/data` holds the ACME account key and every issued certificate. Without it, each
`compose up` — i.e. **each deploy** — starts from an empty `/data` and issues from scratch. Let's
Encrypt allows **5 duplicate certificates per exact hostname per week**; a handful of deploys in
one day would lock issuance out for the rest of the week and leave the box serving nothing. The
volume is what makes this survivable.

### 4. The gateway stops being reachable in cleartext from off-box

`docker-compose.yml` publishes the gateway as **`127.0.0.1:3000:3000`** instead of `3000:3000`.
Loopback is kept deliberately, not carelessly: `http://localhost:3000/ui` is the documented
local-dev entry point (README) and the on-box `curl -sf localhost:3000/...` verification step
depends on it. What it is *not* is reachable from another host.

Terraform then narrows the security group: `ingress_ports = [80, 443]` (plus `443/udp` for
HTTP/3), and the open `:3000` rule is **removed entirely**. Two independent layers now have to fail
before cleartext leaves the box.

### 5. `trustProxy` — a real finding, and a small app change

Investigating whether the app needed any change produced two different answers:

- **The `Secure` cookie flag needs nothing.** `requestIsSecure()` in `apps/gateway/src/auth.ts`
  reads `req.headers["x-forwarded-proto"]` **straight off the raw headers**, falling back to
  `req.protocol` only when the header is absent. Fastify never gates raw header access on
  `trustProxy`, so ADR-0025's claim holds exactly as written and the flag activates behind Caddy
  with zero code change. This was the suspected defect; it is not one. Three regression tests now
  pin the behaviour so a future "simplification" to `req.protocol` cannot silently switch `Secure`
  off.
- **`req.ip` does not.** `auth.ts` records `req.ip` on every `auth_sessions` row (ADR-0025/0028).
  Without `trustProxy`, Fastify returns the socket peer — behind Caddy, the proxy's container
  address. Measured directly: `trustProxy:false` → `172.18.0.5`; `trustProxy:true` →
  `203.0.113.9`. Every session in the audit trail would have recorded the proxy instead of the
  user. For a product whose first pillar is per-user governance with full audit logging, that is a
  real (if quiet) defect introduced *by* adding the proxy.

So `buildApp` now sets `Fastify({ logger: false, trustProxy: true })` — one line, plus tests. It
is safe because the Caddyfile *overwrites* `X-Forwarded-For` with `{remote_host}` rather than
appending to a client-supplied value, so the left-most entry the gateway sees is always the real
peer and cannot be spoofed, and because the gateway port is loopback-only.

### 6. HSTS deliberately OFF

The Caddyfile ships `Strict-Transport-Security` commented out, with the reasoning inline. HSTS is
a browser-side, host-scoped, non-revocable commitment. On a hostname *derived from an IP that can
change*, pinning it removes the plain-HTTP fallback with no server-side undo before `max-age`
expires; and `includeSubDomains` on a `*.sslip.io` name would be hostile to unrelated users of a
free shared service. `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `-Server` are on.
HSTS gets turned on — short `max-age` first — once a stable real domain replaces this name.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| **ALB + ACM** | ~$16–25/month standing charge. Explicitly declined: "no new AWS cost". ACM certificates are free but ACM does not issue for an IP or for a domain you do not control, so the ALB does not solve it alone. |
| **Buy a domain + ACM/Route53** | A domain costs money and a hosted zone is $0.50/month. Same declined constraint, and it drags in registrar lifecycle for a throwaway dev box. |
| **Self-signed certificate** | Free, but every visitor gets a full-page browser interstitial, `curl` needs `-k`, and any future OIDC/webhook/IDE client rejects it outright. It would let us *claim* TLS while training everyone to click through certificate warnings — worse than honest HTTP. Not "TLS done". |
| **CloudFront in front of the instance** | Has a free tier, but is a new AWS resource with real cost past it, needs a domain for a custom certificate anyway, and adds a whole distribution to manage for a dev box. |
| **Tailscale / a VPN / an SSH tunnel** | Solves confidentiality, not usability — the point is a URL a browser can open. Also a new external dependency with its own account model. |
| **nginx + certbot** | Works, but is three moving parts (nginx config, certbot, a renewal cron/timer) versus one container with issuance and renewal built in. Caddy's automatic HTTPS is the entire feature we want. |
| **Keep `:3000` open alongside** | Leaves the cleartext path live, so the vulnerable route still exists and anyone with the old bookmark keeps using it. Removed instead. |

## Consequences

**Easier**
- Session cookies now actually carry `Secure`, over a browser-trusted certificate, with no
  warnings and no `-k`. The ADR-0025 authentication system finally runs on the transport it was
  designed for.
- Renewal is automatic and unattended.
- Moving to a real domain later is a **single env var** (`REGULAIT_TLS_HOST`) — no Caddyfile edit,
  no app change, no Terraform change.
- Session audit rows record the real client IP rather than a container address.

**Harder / given up**
- **The hostname is only as stable as the public IP.** Stop/start or replace the instance and the
  name changes and the certificate is re-issued; bookmarks and any OIDC redirect URIs break. An
  Elastic IP would pin it (free while attached to a running instance) but is a new AWS resource
  and was out of scope here — noted as the mitigation if this becomes painful.
- **A third-party DNS dependency.** sslip.io is free and open-source but not ours. If it stops
  resolving, renewal fails ~60 days later and only the Caddy log says so.
- **Let's Encrypt rate limits are now an operational concern.** `docker compose down -v` on the
  box destroys `caddy_data` and burns a fresh issuance.
- **One more container** in the stack and a `--profile tls` flag that a hand-run
  `docker compose up -d --build` on the box will forget — which yields a running app reachable by
  nobody, since `:3000` is loopback-only. Loud rather than silent, but a footgun.
- One line of app code (`trustProxy`) now depends on the deployment shape being "behind a proxy
  that overwrites `X-Forwarded-For`". Documented in `docker-compose.yml`, the Caddyfile, and
  `app.ts` itself.

**Explicitly unchanged**
- This is still **not production**. TLS closes the cleartext-session hole; it does not upgrade the
  deployment's status, and nothing here creates a `prod` designation. The standing guardrail
  stands.

Runbook, verification commands, and rollback: [`docs/ops/TLS.md`](../ops/TLS.md).

---

### Amendment — 2026-08-01 (ADR-0031)

The `trustProxy: true` this ADR introduced was **too broad**, and the assessment that
`requestIsSecure()` was fine as written was **wrong in one direction**. Both are corrected by
[ADR-0031](0031-p0-hardening-streaming-exports-proxy-trust-rate-limits-csp.md) §3. The decision
above — that the gateway must trust the Caddy front-end, because otherwise `req.ip` degrades to a
container address and the session audit trail loses the real client — stands exactly as written.
What changes is *whose* `X-Forwarded-*` gets believed.

**1. `trustProxy: true` trusted every peer, not the proxy.** The safety argument here rests on
Caddy *overwriting* `X-Forwarded-For` with `{remote_host}`. That is true, and it protects every
request that goes **through** Caddy. It says nothing about requests that do not: the gateway port
is published on host loopback (`127.0.0.1:3000:3000`, by design — the README entry point and the
on-box SSM `curl localhost:3000` verification depend on it), and sibling containers share the
compose network. Anything on either path bypasses Caddy entirely and, under `true`, could choose
the client IP written to `auth_sessions.ip` and carried through the audit trail — the attribution
record pillar 1 sells.

Replaced by an explicit setting resolved from **`REGULAIT_TRUSTED_PROXIES`** (comma-separated IPs,
CIDRs, or the `proxy-addr` keywords `loopback`/`linklocal`/`uniquelocal`; `none`/`off` for nothing;
`all` only if an operator asks for the old behaviour by name).

- **Deployed value: `172.28.0.2` — Caddy's address, and nothing else.** `docker-compose.yml` now
  declares an explicit network with a pinned subnet (`172.28.0.0/16`) and gives the `caddy`
  service that fixed address, purely so the trusted peer can be *named* rather than approximated
  by a subnet that would also cover the `db` container. Host loopback is deliberately **not**
  trusted. With the `tls` profile off, `172.28.0.2` simply does not exist, so nothing is trusted
  and `req.ip` is the socket peer — the same value a laptop saw before.
- **Default when the variable is unset: trust nothing.** That is the right default for anyone
  running the gateway *without* a proxy (laptop, CI, `docker run`, a BYOC install with no
  terminator), where any believed `X-Forwarded-*` is by definition unverifiable. The deployed path
  is correct because the compose file sets the variable, not because the default guesses.
- `main.ts` prints the effective posture at boot, so a misconfiguration surfaces as an
  obviously-wrong IP an operator notices rather than a plausible IP anyone can choose.

**2. `requestIsSecure()` reading the raw header was a real defect, not a non-issue.** The
assessment above is correct that forging `x-forwarded-proto: https` can only turn the cookie's
`Secure` flag **on**, which is harmless. But the same ungated read accepts
`x-forwarded-proto: http` from anything that reaches the port without passing through Caddy — and
that direction issues a session cookie with **no** `Secure` flag, which a browser will then send
in cleartext. An attacker deciding whether our session cookies are protected is not a property to
keep.

`requestIsSecure()` now returns `req.protocol === "https"`, which is Fastify's own trust-gated
answer: it consults `x-forwarded-proto` only for a peer matching `trustProxy`, and otherwise
reports the real socket protocol. Consequences, both deliberate and both tested: a multi-hop
`x-forwarded-proto` is read as the **last** entry (the nearest, trusted hop) rather than the
first — the first is precisely the entry a client can inject when an upstream appends rather than
overwrites, and our Caddy sends a single value so no chain arises here — and a deployment behind a
terminator **must** name it in `REGULAIT_TRUSTED_PROXIES` or `Secure` turns off, which is why the
compose file sets it and boot logs the posture.

The regression wall this ADR asked for is kept and extended: the `Secure` cases are still pinned,
now from both sides of the trust boundary (`apps/gateway/src/auth.test.ts`, describe "ADR-0029
reverse-proxy trust, narrowed by ADR-0031").
