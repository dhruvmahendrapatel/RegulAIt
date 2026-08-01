# TLS for the dev stack — runbook

**What it is:** the `regulait-dev-app` EC2 box serves the app over **HTTPS with a real,
browser-trusted Let's Encrypt certificate**, at no added AWS cost. See
[ADR-0029](../decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md) for why this shape and not
an ALB.

**URL:** `terraform output tls_hostname` — **this is the only authoritative source.** The
`3-229-246-126.sslip.io` literals throughout this file were refreshed on 2026-08-01 and are correct
as of then, but treat them as illustrative: the address moved twice in one day before it was
pinned (`3.237.199.248` → `98.86.163.252` → `3.229.246.126`). As of
[ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md) an Elastic IP pins it, and the box
is [powered off outside weekday hours](POWER_SCHEDULE.md) — so if nothing answers, check whether
it is simply outside the window before debugging TLS.

---

## How it works

```
browser ──443/tcp──▶ Caddy (container, compose profile "tls")  ──▶ gateway:3000
        ──80/tcp───▶   ACME HTTP-01 challenge + 308 → HTTPS         (compose network,
                                                                     plain HTTP, never
                                                                     leaves the box)
```

1. **DNS.** [sslip.io](https://sslip.io) is a free public wildcard-DNS service: it resolves
   `a-b-c-d.sslip.io` to `a.b.c.d` for any IP. No domain purchase, no Route53 hosted zone,
   nothing to register. `3-229-246-126.sslip.io` → `3.229.246.126`.
2. **Certificate.** Caddy's automatic HTTPS sees a site address with a real hostname, requests a
   certificate from Let's Encrypt, and answers the HTTP-01 challenge on `:80` itself. It renews
   at ~2/3 of the lifetime with no cron and no human.
3. **Termination.** Caddy terminates TLS and reverse-proxies to the gateway container over the
   compose network. The gateway itself still speaks plain HTTP — but only on the docker network
   and on host loopback, never off-box.
4. **Proxy headers.** Caddy sets `X-Forwarded-Proto: https`, `X-Forwarded-Host`, and (per our
   Caddyfile) *overwrites* `X-Forwarded-For` with the real peer. The gateway reads
   `x-forwarded-proto` to decide the session cookie's `Secure` flag, and — with Fastify's
   `trustProxy` on — reads `X-Forwarded-For` for the client IP recorded on every `auth_sessions`
   row.

### Where each piece lives

| Thing | File |
| --- | --- |
| Caddy config | `infra/caddy/Caddyfile` |
| `caddy` service, ports, cert volume | `docker-compose.yml` (profile `tls`) |
| Local-proof override (self-signed) | `compose.tls-local.yml` |
| SG ports 80/443, `enable_onbox_tls` | `infra/modules/app-instance/`, `infra/environments/regulait-dev-app/` |
| Hostname derivation at boot | `infra/modules/app-instance/user-data.sh.tftpl` (IMDSv2 → sslip.io name) |
| `trustProxy` | `apps/gateway/src/app.ts` |

---

## Operating it

### Bring it up (on the box)

```bash
cd /opt/app
docker compose --profile tls up -d --build
docker compose logs -f caddy          # watch for "certificate obtained successfully"
```

Terraform's user-data already does this on first boot, including deriving `REGULAIT_TLS_HOST`
from IMDS and writing it into `docker-compose.override.yml`.

### Verify

```bash
curl -sI https://3-229-246-126.sslip.io/ui | head -1        # 200, and NO -k needed
curl -sI http://3-229-246-126.sslip.io/ui  | head -1        # 308 → https
echo | openssl s_client -connect 3-229-246-126.sslip.io:443 \
       -servername 3-229-246-126.sslip.io 2>/dev/null | grep -E "issuer|subject"
```

The cookie check that actually matters — log in and confirm the flag is on:

```bash
curl -si -X POST https://3-229-246-126.sslip.io/auth/login \
  -H 'x-regulait-csrf: 1' -H 'content-type: application/json' \
  -d '{"email":"...","password":"..."}' | grep -i set-cookie
# expect: ... HttpOnly; SameSite=Strict; Max-Age=86400; Secure
```

### Prove it locally without touching Let's Encrypt

```bash
docker compose --profile tls -f docker-compose.yml -f compose.tls-local.yml up --build
curl -k -I https://localhost/ui
```

The override swaps in Caddy's `internal` issuer (its own local CA). **Never run the ACME path
from a laptop** — a laptop cannot pass an HTTP-01 challenge for the box's hostname, and each
failure counts against Let's Encrypt's failed-validation limit (5 per account/hostname/hour).

---

## Caveats — read before relying on this

1. **The hostname is derived from the public IP — RESOLVED by ADR-0032, see below.** Stop/start
   the instance (or replace it) and an auto-assigned IP changes, so the hostname changes, so the
   old certificate is useless and Caddy issues a new one for the new name. Any bookmark, OIDC
   redirect URI, or IDE base URL pointing at the old name breaks. **This already happened once**:
   the box was stopped and its address moved from `3.229.246.126` to `98.86.163.252` while every
   literal in this file and the Caddyfile still said the old one.

   **Now mitigated:** [ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md) attaches an
   **Elastic IP** (`assign_elastic_ip = true`), which survives stop/start and pins the hostname for
   the life of the stack. This was mandatory once the box started being powered off nightly to save
   cost — see [POWER_SCHEDULE.md](POWER_SCHEDULE.md).

   *Correcting the pricing claim that used to sit here:* an EIP is **not** free while attached.
   Since 2024-02-01 AWS bills **every** public IPv4 at ~$0.005/hr, idle *or* in use — so an EIP
   costs exactly what the auto-assigned address already cost while the box runs, and ~$2.35/month
   extra for the hours it is stopped.

   Treat every `3-229-246-126.sslip.io` literal in this file as illustrative.
   `terraform output tls_hostname` is the only authoritative source.
2. **sslip.io is a third-party service.** It is free, long-running, and open-source, but it is not
   ours. If it goes away or rate-limits, the hostname stops resolving and — worse — renewal fails
   ~60 days later, quietly, until the certificate expires. `docker compose logs caddy` is the only
   place that will say so. This is an accepted dev-stack risk, not a production posture.
3. **Let's Encrypt rate limits.** 5 duplicate certificates per exact hostname per week; 5 failed
   validations per account/hostname/hour. The `caddy_data` named volume exists precisely so
   repeated deploys reuse the stored certificate instead of re-issuing. **Do not `docker compose
   down -v` on the box** — that deletes the volume and burns a fresh issuance.
4. **HSTS is owned by the GATEWAY, not by Caddy — and it is ON, deliberately short.** This page
   used to say "HSTS is off on purpose", matching the Caddyfile comment. That was wrong: Caddy set
   no `Strict-Transport-Security`, but the gateway behind it had been adding
   `max-age=31536000; includeSubDomains` to every secure response since ADR-0031, so the box
   really was announcing a one-year pin. Resolved by the ADR-0029 amendment of 2026-08-01 —
   **exactly one layer sets this header, and it is the gateway**, because the gateway is what
   ships into BYOC/air-gapped installs where no Caddy of ours exists.

   Current value: **`max-age=86400`** — one day, **no** `includeSubDomains`, **no** `preload`. It
   rides only a genuinely secure request (a real TLS hop, or one from a peer named in
   `REGULAIT_TRUSTED_PROXIES`), never a plaintext hop or a forged `x-forwarded-proto`.

   Change it with the gateway's **`REGULAIT_HSTS`** env var (`off` for none; any valid value
   verbatim; a malformed value fails the boot rather than silently sending nothing). The effective
   posture is printed in the gateway's boot log next to the proxy posture. **Do not add a
   `Strict-Transport-Security` directive to the Caddyfile** — two layers setting it is the defect
   that was fixed. Raise the `max-age` (and consider `includeSubDomains`) only behind a real,
   stable domain; on this sslip.io name a released Elastic IP hands the hostname to a stranger,
   who would inherit the pin along with it.
5. **:80 is not optional.** It carries the ACME challenge for issuance *and every renewal*.
   Closing it in the security group breaks renewal silently, two months later.
6. **Still not production.** One instance, one container of each thing, dev-grade seed data, no
   ALB, no WAF, no multi-AZ. TLS closes the cleartext-session hole; it does not change the
   deployment's status. The standing guardrail in `CLAUDE.md` applies.

---

## Moving to a real domain later

One line changes. Point an A record at the box, then:

```bash
# in the compose environment (or docker-compose.override.yml on the box)
REGULAIT_TLS_HOST=regulait.example.com
docker compose --profile tls up -d
```

Caddy issues a certificate for the new name on first request and keeps serving the old one until
it expires. Nothing in the app, the Caddyfile, or Terraform needs editing — `REGULAIT_TLS_HOST` is
the whole switch. At that point also drop `enable_onbox_tls`'s IMDS-derived override in
`user-data.sh.tftpl` (or set the variable explicitly) so boot stops recomputing the sslip.io name,
and raise HSTS on the gateway — `REGULAIT_HSTS=max-age=31536000; includeSubDomains` is the
conventional end state once the name is one you own and intend to keep. Ramp it (a day, then a
week, then a year); each value replaces the previous one in the browsers of visitors who return
over HTTPS, so the ladder is climbable in both directions.

---

## Rollback

TLS is additive and reversible; nothing about the app depends on it.

**Fast, on the box (no Terraform):**

```bash
cd /opt/app
docker compose --profile tls stop caddy
# re-expose the app directly (dev only — this is cleartext again)
docker compose up -d
```
…and re-open `:3000` in the security group if you need it off-box.

**Full revert:** `git revert` the TLS commits and re-apply Terraform. The SG returns to the single
open `:3000` rule, `user-data.sh.tftpl` stops writing the caddy override, and the compose stack
publishes `3000:3000` again. The `caddy_data` volume can be left in place — an unused volume costs
nothing and preserves the ACME account/cert if TLS is turned back on.
