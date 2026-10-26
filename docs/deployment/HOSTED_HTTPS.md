# Hosted HTTPS front door (the hosted demo)

[ADR-0202](../../internal/decisions/0202-live-integrations-hosted-demo.md) decision 3: the existing dev host serves
the app over HTTPS on a subdomain of a domain the owner already owns. This page is the owner's runbook. Every host
name below is a placeholder (`demo.example.com`, address `203.0.113.10`); the real ones live only in DNS, in the box's
own `.env` and in an untracked `*.tfvars` file, never in this repository.

It is still a **demo environment, not production** (standing guardrail). Nothing here creates a production
designation.

## What is already in place, and what this adds

The box has terminated TLS since [ADR-0029](../../internal/decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md):
an in-compose Caddy (`caddy:2.11.7-alpine`, pinned by digest, Apache-2.0) with automatic Let's Encrypt certificates,
on a name derived from the box's Elastic IP ([ADR-0032](../../internal/decisions/0032-scheduled-power-off-dev-infra.md)).
The security group opens only 80 and 443; the gateway's 3000 is bound to host loopback, so it does not answer from
off the box. Terraform now refuses a plan that would open the app port while the TLS front is on.

This change lets the box serve a **name you choose** instead:

| Piece | Where |
| --- | --- |
| `hosted` compose profile (same Caddy service as the `tls` profile) | `docker-compose.yml` |
| Served name: `REGULAIT_PUBLIC_HOST`, falling back to `REGULAIT_TLS_HOST` | `docker-compose.yml`, `infra/caddy/Caddyfile` |
| Name checked against `REGULAIT_PUBLIC_URL` before Caddy is pointed at it | `infra/scripts/hosted-config.sh` |
| Every boot keeps Caddy on that name (not on the address-derived one) | `infra/scripts/boot-resync.sh` |
| Sign-in service (Keycloak, profile `sso`) on the same name under `/idp` | `infra/caddy/Caddyfile`, `docker-compose.yml` |
| `dns_a_record` and `hosted_env` outputs | `infra/environments/regulait-dev-app` |

With no profile, `docker compose up` is the laptop demo on `http://localhost:3000`, unchanged.

For the laptop-hosted demo behind a Cloudflare Tunnel (no inbound port, no ACME), use the `tunnel` profile instead:
[TUNNEL.md](TUNNEL.md). It shares this front's routes (`infra/caddy/routes.Caddyfile`) and its trusted address.

## Variables

| Variable | Example | Meaning |
| --- | --- | --- |
| `REGULAIT_PUBLIC_HOST` | `demo.example.com` | The name Caddy serves and gets a certificate for. Lowercase DNS name; no scheme, port or path. |
| `REGULAIT_PUBLIC_URL` | `https://demo.example.com` | Must be exactly `https://` + `REGULAIT_PUBLIC_HOST`. Every outbound link, OAuth callback, the federation issuer and the Keycloak redirect URI are built from it. |
| `REGULAIT_TLS_EMAIL_DIRECTIVE` | `email ops@example.com` | Optional ACME contact for expiry warnings. Empty is allowed. |
| `REGULAIT_KC_HOSTNAME` | `https://demo.example.com/idp` | Only with the `sso` profile. Must be the same name under `/idp`. |
| `REGULAIT_KC_RELATIVE_PATH` | `/idp` | Only with the `sso` profile. Keycloak serves under this path. Default `/` (laptop). |
| `REGULAIT_HSTS` | `max-age=86400` | Already set to one day in the box's `docker-compose.override.yml`. The gateway owns this header, not Caddy. |

`hosted-config.sh` refuses (and the box keeps its current name) when `REGULAIT_PUBLIC_HOST` is not a valid name, or
when `REGULAIT_PUBLIC_URL` or `REGULAIT_KC_HOSTNAME` spell a different origin.

## Owner steps

Run them in this order. Pointing Caddy at a name before its DNS record resolves makes every ACME attempt fail, and
Let's Encrypt allows only 5 failed validations per name per hour.

### 1. Get the address and the record (master session, with the owner's go-ahead)

```sh
cd infra/environments/regulait-dev-app
terraform init -backend-config=backend.hcl
terraform plan -var public_hostname=demo.example.com
```

The plan should change **outputs only** (`app_url`, `federation_issuer_url`, `tls_hostname`, `dns_a_record`,
`hosted_env`). If it proposes to change the instance, the security group or the Elastic IP, stop: that is drift to
investigate, not part of this change. Apply only with the owner's go-ahead in that session, then:

```sh
terraform output dns_a_record   # { name = "demo.example.com", type = "A", value = "203.0.113.10" }
terraform output -raw hosted_env
```

### 2. Create the DNS record (owner)

At the DNS provider of the parent domain, create one record: `A`, name `demo` (the subdomain), value the Elastic IP
from step 1, TTL 300. No AAAA record (the box has no IPv6 address). Then wait until it resolves:

```sh
dig +short demo.example.com A    # must print exactly the Elastic IP
```

### 3. Switch the box (owner, on the host, through SSM)

```sh
cd /opt/app
# bring the checkout to the merged main the usual way, then:
sudo sed -i '/^REGULAIT_PUBLIC_URL=/d;/^REGULAIT_PUBLIC_HOST=/d' .env
sudo tee -a .env >/dev/null <<'EOF'
REGULAIT_PUBLIC_HOST=demo.example.com
REGULAIT_PUBLIC_URL=https://demo.example.com
EOF
sudo bash infra/scripts/hosted-config.sh want-host .env   # prints demo.example.com, or why not
sudo bash infra/scripts/boot-resync.sh                    # installs the boot unit and both scripts, points Caddy at the name
docker compose --profile hosted up -d                     # recreates the gateway with the new REGULAIT_PUBLIC_URL
```

`boot-resync.sh` rewrites `REGULAIT_TLS_HOST` in `docker-compose.override.yml` (it keeps a `.bak.<time>` copy) and
runs it again on every boot, so the name survives the power schedule.

### 4. With the sign-in service (only if the `sso` profile runs on the box)

Add to `.env`, then `docker compose --profile hosted --profile sso up -d`:

```sh
REGULAIT_KC_HOSTNAME=https://demo.example.com/idp
REGULAIT_KC_RELATIVE_PATH=/idp
```

Caddy proxies only `/idp/realms/` and `/idp/resources/` to Keycloak and answers 404 for the rest of `/idp`, so the
admin console stays off the internet. The realm is imported only once (`--import-realm`), so an **existing** realm
keeps its old redirect URI: in the admin console (through an SSM port-forward to `127.0.0.1:8080`) set the
`regulait-gateway` client's redirect URI to `https://demo.example.com/auth/oidc/callback`, its web origin to
`https://demo.example.com` and its post-logout URI to `https://demo.example.com/ui/login`. The issuer you enter in
/ui/admin/sso becomes `https://demo.example.com/idp/realms/regulait`. Upstream identity providers' callbacks become
`https://demo.example.com/idp/realms/regulait/broker/<alias>/endpoint`.

### 5. Re-register what pointed at the old origin

Changing `REGULAIT_PUBLIC_URL` changes every URL a third party was given: the federation issuer
(`<public URL>/federation`, trusted by cloud OIDC providers), OAuth app callbacks, and the Slack, Jira and Azure DevOps
callback URLs. Update each of them to the new origin; lane L's account runbook lists them per service.

## Verify

```sh
curl -sI http://demo.example.com/ui | head -1                  # 308, Location: https://demo.example.com/ui
curl -sI https://demo.example.com/ui | grep -i strict-transport # max-age=86400, from the gateway
curl -s  https://demo.example.com/health                        # gateway health
curl -s -o /dev/null -w '%{http_code}\n' https://demo.example.com/idp/admin/   # 404: admin console not published
nc -vz -w 5 203.0.113.10 3000                                   # must fail: 3000 is not reachable from outside
docker compose logs caddy | grep -i "certificate obtained"
```

In a browser: sign in at `https://demo.example.com/ui` and check in the developer tools that the session cookie is
`Secure; HttpOnly; SameSite=Strict`. The gateway sets `Secure` because Caddy sends `X-Forwarded-Proto: https` from
its fixed address `172.28.0.2`, the only peer `REGULAIT_TRUSTED_PROXIES` (and Keycloak's
`KC_PROXY_TRUSTED_ADDRESSES`) believes.

## Cross-origin requests

The gateway sends no CORS headers, so browsers allow no cross-origin reads of its API: the UI is served from the
same origin. Nothing in this change adds an allow-list entry. Cookie-authenticated writes also need the
`x-regulait-csrf: 1` header, which a cross-site form cannot set.

## Rolling back

Remove `REGULAIT_PUBLIC_HOST` from `.env`, set `REGULAIT_PUBLIC_URL` back to the address-derived `https://` name, and
run `sudo bash infra/scripts/boot-resync.sh`: with no hosted name it points Caddy at the address-derived name again.
Keep the DNS record until the switch back is done.

## Not verified here

- Steps 1 to 5 have not been executed on the box. `hosted-config.sh` and `boot-resync.sh`'s hosted mode are covered
  by `scripts/hosted-front-door.test.mjs` against a scratch directory with a stubbed `docker compose`.
- A real ACME issuance for a real name: the routing, the 308 redirect, the header handling and the 404 on
  `/idp/admin/` were proven against Caddy 2.11.7 with its internal CA and stub upstreams, not on the box.
- Keycloak under `/idp` on the box (`KC_HTTP_RELATIVE_PATH`, `KC_PROXY_TRUSTED_ADDRESSES` on 26.8.0).
- The gateway fetching the Keycloak discovery document through the box's own public name.
