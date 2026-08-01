# TLS for the dev stack — runbook

**What it is:** the `regulait-dev-app` EC2 box serves the app over **HTTPS with a real,
browser-trusted Let's Encrypt certificate**, at no added AWS cost. See
[ADR-0029](../decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md) for why this shape and not
an ALB.

**URL:** `https://3-237-199-248.sslip.io` (the sslip.io name for the box's current public IP;
`terraform output tls_hostname` is authoritative).

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
   nothing to register. `3-237-199-248.sslip.io` → `3.237.199.248`.
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
curl -sI https://3-237-199-248.sslip.io/ui | head -1        # 200, and NO -k needed
curl -sI http://3-237-199-248.sslip.io/ui  | head -1        # 308 → https
echo | openssl s_client -connect 3-237-199-248.sslip.io:443 \
       -servername 3-237-199-248.sslip.io 2>/dev/null | grep -E "issuer|subject"
```

The cookie check that actually matters — log in and confirm the flag is on:

```bash
curl -si -X POST https://3-237-199-248.sslip.io/auth/login \
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

1. **The hostname is derived from the public IP.** Stop/start the instance (or replace it) and the
   IP changes, so the hostname changes, so the old certificate is useless and Caddy issues a new
   one for the new name. Any bookmark, OIDC redirect URI, or IDE base URL pointing at the old name
   breaks. **Mitigation if this becomes painful:** an Elastic IP is free *while attached to a
   running instance* (AWS bills idle/unattached EIPs), which pins the hostname for the life of the
   stack — but that is a new AWS resource and was not in scope here, so it is not applied.
2. **sslip.io is a third-party service.** It is free, long-running, and open-source, but it is not
   ours. If it goes away or rate-limits, the hostname stops resolving and — worse — renewal fails
   ~60 days later, quietly, until the certificate expires. `docker compose logs caddy` is the only
   place that will say so. This is an accepted dev-stack risk, not a production posture.
3. **Let's Encrypt rate limits.** 5 duplicate certificates per exact hostname per week; 5 failed
   validations per account/hostname/hour. The `caddy_data` named volume exists precisely so
   repeated deploys reuse the stored certificate instead of re-issuing. **Do not `docker compose
   down -v` on the box** — that deletes the volume and burns a fresh issuance.
4. **HSTS is off on purpose.** See the comment block in the Caddyfile: HSTS on an IP-derived
   hostname is a browser-side commitment you cannot revoke, and `includeSubDomains` on a
   `*.sslip.io` name would affect unrelated users of the service. Turn it on only behind a real,
   stable domain, starting with a short `max-age`.
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
and consider turning HSTS on.

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
