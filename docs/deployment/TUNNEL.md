# Cloudflare Tunnel front door (the laptop-hosted demo)

The owner's decision on #453: for the demo, the stack runs on the owner's laptop and is published at
`regulait.<domain>` through a **Cloudflare Tunnel**. The domain's DNS is on Cloudflare. The laptop opens **no inbound
port**, and HTTPS uses Cloudflare's certificate. This page is the owner's runbook for the `tunnel` compose profile
(ADR-0203 lane T). Every name below is a placeholder (`demo.example.com`). The real name goes only in the Cloudflare
dashboard and in the laptop's untracked `.env`, never in this repository.

It is still a **demo environment, not production** (standing guardrail).

For the 2026-11-01 and 2026-11-03 demo, this laptop is the live instance (ADR-0203, replacing the AWS dev host). Its
one-time live preparation (the local override, the single `down -v`, `demo:prepare --live`, passwords, admin MFA and
`demo:check --live`) is in [DEMO_RUNBOOK.md §7.6](../../internal/product/DEMO_RUNBOOK.md#76-live-host-recipes-pending-execution).

## How it fits together

```
browser --HTTPS--> Cloudflare edge (certificate, "Always Use HTTPS")
                        ^
                        | outbound-only tunnel, started by the laptop (port 7844, QUIC or HTTP/2)
                        |
   cloudflared  --HTTP, private `tunnel` network-->  caddy-tunnel  -->  gateway:3000
   (profile tunnel)                                  (172.28.0.2)  -->  keycloak:8080 (/idp/realms, /idp/resources)
```

| Piece | Where |
| --- | --- |
| `cloudflared` service: pinned by digest, outbound only, no ports, token from `REGULAIT_CF_TUNNEL_TOKEN` | `docker-compose.yml` |
| `caddy-tunnel` service: plain HTTP on the private `tunnel` network, no ACME, no ports | `docker-compose.yml`, `infra/caddy/tunnel.Caddyfile` |
| The routes, shared with the TLS front: the `/idp` allow-list, the gateway proxy, overwritten forwarding headers | `infra/caddy/routes.Caddyfile` |
| Pre-flight check that fails closed | `infra/scripts/hosted-config.sh tunnel-check` |

What protects what:

- **cloudflared can reach only caddy-tunnel.** It is on the `tunnel` network alone, so a dashboard service URL that
  points anywhere else (`gateway:3000`, `keycloak:8080`, `db:5432`) resolves to nothing.
- **caddy-tunnel accepts requests only from cloudflared's fixed address** on that network. It drops everything else
  before it reads a header, and its listener is not on the network the database and the gateway use.
- **The client IP is the one Cloudflare saw.** caddy-tunnel takes `CF-Connecting-IP` (Cloudflare's edge sets it and
  overwrites any value a client sent), refuses a request where that header is missing or is not a single address,
  writes it into `X-Forwarded-For` and `X-Real-IP`, and then strips the header. Any `X-Forwarded-For` from the client is
  discarded.
- **`https` is only claimed when it is true.** A request that Cloudflare received over plain HTTP is redirected to
  `https://` before it is proxied.
- **The gateway and Keycloak trust lists do not change.** caddy-tunnel holds the TLS front's address `172.28.0.2`,
  the only address `REGULAIT_TRUSTED_PROXIES` and `KC_PROXY_TRUSTED_ADDRESSES` accept `X-Forwarded-*` from
  (ADR-0031). That is why the session cookie gets `Secure` and the audit trail records the real client IP.
- **One public door at a time.** `tunnel` replaces `hosted`/`tls`. If you start both, compose refuses the second
  front with "Address already in use", and `tunnel-check` refuses when `COMPOSE_PROFILES` names both.

With no profile, `docker compose up` is still the laptop demo on `http://localhost:3000`, unchanged.

## Variables

| Variable | Example | Where | Meaning |
| --- | --- | --- | --- |
| `REGULAIT_PUBLIC_HOST` | `demo.example.com` | `.env` | The public name. A lowercase DNS name, with no scheme, port or path. |
| `REGULAIT_PUBLIC_URL` | `https://demo.example.com` | `.env` | Must be exactly `https://` + `REGULAIT_PUBLIC_HOST`. Links, OAuth callbacks, the federation issuer and the Keycloak redirect URI are built from it. |
| `REGULAIT_CF_TUNNEL_TOKEN` | *(from the dashboard)* | the shell session only | The tunnel's only credential. Keep it in the password manager and set it per session (below). Never put it in a file in the repository, a commit, an issue or a chat. |
| `REGULAIT_KC_HOSTNAME` | `https://demo.example.com/idp` | `.env` | Only with the `sso` profile: the same name under `/idp`. |
| `REGULAIT_KC_RELATIVE_PATH` | `/idp` | `.env` | Only with the `sso` profile. |

Leave `REGULAIT_TRUSTED_PROXIES` and `REGULAIT_KC_TRUSTED_PROXIES` unset (or `172.28.0.2`). `tunnel-check` refuses
anything else.

## Owner steps

### 1. Create the tunnel (Cloudflare dashboard)

1. Open **Zero Trust › Networks › Tunnels** and choose **Create a tunnel**.
2. Pick the **Cloudflared** connector type and name the tunnel, for example `regulait-demo`.
3. On the **Install and run a connector** page, the dashboard shows an install command that ends in a long token.
   Copy **only the token**, the long string after `--token` (or after `service install`), into the password manager.
   Do **not** run the install command on the laptop. Compose runs cloudflared for you, and a second, system-wide
   connector would serve the same tunnel outside this stack.

### 2. Add the public hostname (Cloudflare dashboard)

In the tunnel's **Public Hostname** tab (it may be labelled **Published application routes**), add one route:

| Field | Value |
| --- | --- |
| Subdomain | `regulait` (in this page's examples, `demo`) |
| Domain | your domain (here `example.com`) |
| Path | *(empty)* |
| Service type | `HTTP` |
| URL | `caddy-tunnel:8080` |

Leave **HTTP Host Header** empty: caddy-tunnel answers only for the public name, and cloudflared passes it through.
Add no other route. The dashboard creates the DNS record (a proxied `CNAME` to the tunnel) for you.

### 3. Zone settings (Cloudflare dashboard, your domain)

- **SSL/TLS › Edge Certificates › Always Use HTTPS**: on. caddy-tunnel redirects plain HTTP anyway, but it is better
  if HTTP is never forwarded through the tunnel at all.
- **SSL/TLS › Edge Certificates › Minimum TLS Version**: TLS 1.2 or higher.
- **Do not turn on Cloudflare's HSTS setting.** The gateway owns `Strict-Transport-Security` (`REGULAIT_HSTS`,
  ADR-0029 amendment). Two layers setting it is the defect that was fixed. For a demo name, set
  `REGULAIT_HSTS=max-age=86400` in `.env`.

### 4. Configure the laptop (Windows PowerShell)

In the repository checkout, add the non-secret settings to `.env`. It is untracked (`.gitignore`):

```powershell
Add-Content .env "REGULAIT_PUBLIC_HOST=demo.example.com"
Add-Content .env "REGULAIT_PUBLIC_URL=https://demo.example.com"
Add-Content .env "REGULAIT_HSTS=max-age=86400"
# only if the sign-in service (profile sso) runs:
Add-Content .env "REGULAIT_KC_HOSTNAME=https://demo.example.com/idp"
Add-Content .env "REGULAIT_KC_RELATIVE_PATH=/idp"
```

If `.env` already has any of these names, edit the existing lines instead. When a name appears twice, the last line
wins.

Then set the token **for this PowerShell session only**. Paste it from the password manager at the hidden prompt:

```powershell
# PowerShell 7+
$env:REGULAIT_CF_TUNNEL_TOKEN = Read-Host -MaskInput "Tunnel token"
# Windows PowerShell 5.1
$t = Read-Host -AsSecureString "Tunnel token"
$env:REGULAIT_CF_TUNNEL_TOKEN = [System.Net.NetworkCredential]::new("", $t).Password
Remove-Variable t
```

The variable disappears when the window closes. Don't add it to `.env`, a profile script or the system
environment, and don't run `docker compose config` while it is set: that command prints the resolved environment,
token included.

### 5. Check, then start

Run the pre-flight check with Git for Windows' bash, which inherits the session's variables. Do not use WSL's
`bash`: it does not see `$env:` variables.

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" infra/scripts/hosted-config.sh tunnel-check .env
# with the sign-in service:
& "$env:ProgramFiles\Git\bin\bash.exe" infra/scripts/hosted-config.sh tunnel-check .env --sso
```

It prints `tunnel config ok: https://demo.example.com`, or every reason it refuses, and exits 2. It never prints the
token. Start only when it passes:

```powershell
docker compose --profile tunnel up -d
# with the sign-in service:
docker compose --profile tunnel --profile sso up -d
```

If `COMPOSE_PROFILES` is set in `.env` or in the session, it must not name `hosted` or `tls`.

### 6. With the sign-in service

The rest is the same as the hosted front: see [HOSTED_HTTPS.md](HOSTED_HTTPS.md) step 4 for the `regulait-gateway`
client's redirect URI, web origin and post-logout URI. The issuer becomes `https://demo.example.com/idp/realms/regulait`.
The admin console stays unpublished (`/idp/admin/` answers 404 through the tunnel). On the laptop itself it is at
`http://127.0.0.1:8080/idp/admin/` (compose binds Keycloak to loopback only).

### 7. Re-register what points at the old origin

Changing `REGULAIT_PUBLIC_URL` changes every URL a third party was given: the federation issuer, OAuth app callbacks,
and the Slack, Jira and Azure DevOps callback URLs. [HOSTED_HTTPS.md](HOSTED_HTTPS.md) step 5 lists them.

## Verify

```powershell
docker compose ps cloudflared caddy-tunnel           # both running; the PORTS column is empty for both
docker compose logs cloudflared | Select-String "Registered tunnel connection"   # usually four connections
curl.exe -sI https://demo.example.com/ui             # 200 or 30x from the gateway, over Cloudflare's certificate
curl.exe -sI https://demo.example.com/ui | Select-String -Pattern "strict-transport"   # max-age=86400, from the gateway
curl.exe -s https://demo.example.com/health          # gateway health
curl.exe -s -o NUL -w "%{http_code}`n" https://demo.example.com/idp/admin/   # 404: admin console not published
curl.exe -sI http://demo.example.com/ui              # 301/308 to https://
docker compose logs caddy-tunnel --tail 5            # requests logged; the gateway records your public IP, not 192.168.255.251
```

The dashboard's tunnel list should show the tunnel as **HEALTHY**. In a browser, sign in at
`https://demo.example.com/ui` and check in the developer tools that the session cookie is
`Secure; HttpOnly; SameSite=Strict`.

To confirm nothing is listening for the internet on the laptop: `docker compose ps` shows no published port except
the gateway's `127.0.0.1:3000`, which is loopback only.

## Optional hardening (Cloudflare dashboard)

- **Rate limiting** (**Security › WAF › Rate limiting rules**): for example, block an IP that sends more than 20
  requests in 10 seconds to a path starting with `/auth/`, and set a broader limit for the whole hostname. The gateway
  has its own limits as well. These rules stop abuse at the edge, before it uses the laptop's bandwidth.
- **Cloudflare Access for the UI only.** If you add an Access application, scope it to the path `/ui` on
  `demo.example.com`, and do **not** put a hostname-wide Access policy in front of the tunnel. Machine callers cannot
  complete an Access login, so these paths must stay open:
  - `/v1/chatops/*`: Slack events, interactions and bot messages (signed by Slack and verified by the gateway).
  - `/v1/pm/webhooks/*`: Jira, Azure DevOps and the other PM tools' webhooks (verified by the gateway).
  - `/federation/*` and `/.well-known/*`: the OIDC federation issuer and JWKS that cloud providers fetch.
  - `/idp/realms/*` and `/idp/resources/*`: OIDC endpoints that identity providers and the gateway call back to.
  - `/auth/oidc/*`: the sign-in redirect and callback.
  - `/oauth/*`, `/scim/v2/*`, `/mcp/*` and the rest of `/v1/*`: API, SCIM and MCP clients that authenticate with
    their own tokens.

  Access in front of `/ui` is an extra gate, not a replacement: the gateway's own sign-in, MFA and per-user
  entitlements still apply behind it.

## Stopping and rolling back

```powershell
docker compose --profile tunnel down      # the public name stops answering (Cloudflare shows error 1033); never add -v on the live laptop (DEMO_RUNBOOK §7.6)
Remove-Item Env:REGULAIT_CF_TUNNEL_TOKEN
```

To retire the tunnel, delete it in **Zero Trust › Networks › Tunnels**. That revokes the token, and the dashboard
removes the DNS record. If the token leaks, rotate it in the tunnel's settings (refresh the token) and use the new
one. The old token stops working.

## Not verified here

- No real tunnel has run. A tunnel needs a Cloudflare account, a zone and a token, and CI has none of them. The
  dashboard labels above are as of 2026-10 and may move.
- Verified locally with the pinned Caddy 2.11.7 binary and a stub upstream:
  - `tunnel.Caddyfile` drops a peer that is not cloudflared's address, returns 308 for a non-`https`
    `X-Forwarded-Proto` (including a repeated header), returns 400 for a missing, listed or repeated
    `CF-Connecting-IP`, and sends `X-Forwarded-For`/`X-Real-IP` = the client IP, `X-Forwarded-Proto: https` and
    `X-Forwarded-Host` = the public name, with `CF-Connecting-IP` removed.
  - `/idp/realms/*` reaches Keycloak and `/idp/admin/` returns 404.
  - The TLS front's `Caddyfile`, refactored onto the same routes file, still proxies with the overwritten headers.
- `scripts/tunnel-front-door.test.mjs` covers `tunnel-check` (fails closed, never prints the token) and the compose
  wiring. `docker compose config` with no profile is byte-identical to before this change.
