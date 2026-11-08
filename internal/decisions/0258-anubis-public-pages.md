# ADR-0258: Anubis as an optional bot and AI-scraper check in front of the public pages only

- **Status**: Proposed
- **Date**: 2026-11-07
- **Index**: Anubis as an optional, off-by-default proof-of-work bot and AI-scraper check in front of the public trust centre, auditor portal and supplier portal only (backlog P34)

## Context

Owner-approved on 2026-11-07 as backlog P34 (PENDING.md, "from the security and infra review"): add **Anubis**
(TecharoHQ/anubis, MIT, Go, v1.28.x) as an optional proof-of-work anti-bot and anti-AI-scraper reverse proxy in front of
RegulAIt's **public pages only**: the trust centre ([ADR-0225](0225-outward-trust-pages.md)), the supplier portal
([ADR-0221](0221-supplier-portal.md)) and the auditor portal (ADR-0225). It must never cover the API, the admin console or
the gateway. The brief also asked for: a compose and installer profile plus a BYOC/Kubernetes hook, off by default, with
turning it on an admin deployment choice recorded in the deployment docs; a pinned version and image digest with no
runtime downloads; a THIRD_PARTY.md row and a check of the mascot images' branding rules; a policy that blocks known
scrapers, allows good bots only by explicit choice, rate-limits and logs without visitor PII beyond what is needed; an
allow-list path for named auditors; and an accessibility check against DESIGN_GUIDELINES.md.

The public pages today are a static SPA shell (`/ui/trust`, `/ui/audit`, `/ui/supplier`) and their public endpoints
(`/v1/trust-center`, `/v1/auditor/*`, `/v1/supplier/*`). Each is off until an admin enables it, and the gateway already
rate-limits them per address. The auditor and supplier sign-in links carry a single-use token in the URL fragment, which
no server receives.

**Secure by default (ADR-0180) cuts both ways here.** Anubis is defence in depth whose cost falls on real users: an
auditor or supplier on a locked-down browser (JavaScript off, strict script blocking, some assistive setups) can fail
the JavaScript challenge and be shut out of a portal they were invited to. So it ships off, and turning it on is an
admin's deployment choice.

## Decision

**1. Subrequest mode behind our Caddy, not a second reverse proxy.** Anubis runs with `TARGET=" "` and Caddy asks it about
each request to a public path (`forward_auth` to `/.within.website/x/cmd/anubis/api/check`). On a 2xx Caddy proxies to
the gateway itself through the same shared proxy block as every other route; a 401 becomes a 307 to Anubis's challenge;
any other answer (403 for a denied scraper) is returned as it is. `/.within.website/*` is routed to Anubis. Reasons:
Caddy stays the only peer the gateway trusts for `X-Forwarded-*` (ADR-0031), so the audit trail and per-address rate
limits keep seeing the real client address; Anubis has no network route to the gateway; and the scope is a Caddy path
matcher that names only the public paths, so the API, the admin console, `/idp` and the gateway's model and MCP routes
cannot be covered by accident. The gate lives in `infra/caddy/routes.Caddyfile`, which both public fronts (TLS and
tunnel) import, chosen by `REGULAIT_ANUBIS` = `off` (default) or `on`; any other value names a snippet that does not
exist, so Caddy refuses to start.

**2. Off by default, one switch.** Compose profile `anubis` plus `REGULAIT_ANUBIS=on`; `scripts/install.sh --anubis`
sets both (kept across re-runs, `--no-anubis` reverses it) and refuses `--anubis` with `--tls none`, because the gate
needs our Caddy. The switch without the profile fails closed (the public pages answer 502); the profile without the
switch runs Anubis and never asks it. For BYOC on Kubernetes or behind the customer's own proxy,
`infra/anubis/k8s/anubis.yaml` is a pinned, single-replica, non-root, read-only Deployment and ClusterIP Service in the
same mode, and `docs/deployment/ANUBIS.md` says how to wire the customer's proxy to the public paths only. The setting
is a deployment file, not an in-app setting, so the product's audit log does not see it; the deployment doc tells the
admin to record who turned it on, when and why, with the allow-list in force.

**3. Pinned and air-gapped.** `ghcr.io/techarohq/anubis:v1.28.2@sha256:5fcbce70…` (the OCI index, resolved 2026-11-07),
the same in compose and the Kubernetes hook. `scripts/build-image-bundle.sh --with-anubis` carries it; the air-gapped
install runs the plain tag and checks its image id against the pinned ids (as for Caddy). The policy uses nothing that
calls out: no GeoIP or ASN rules (they need the hosted Thoth service), `dnsbl: false`, no `remote_addresses_url`,
Open Graph off, honeypot off, in-memory store. A test refuses those keys.

**4. Policy (`infra/anubis/policy.yaml`), first match wins.**
- The named-auditor **allow-list** (`/etc/anubis/allowlist.yaml`, `REGULAIT_ANUBIS_ALLOWLIST_FILE`): ALLOW by the
  egress address ranges an auditor or supplier gives us. They still sign in with their single-use link.
- **Known scrapers denied** (403): Anubis's `_deny-pathological` set and `ai-block-aggressive` (every AI/LLM agent,
  crawler and training or search fetcher it knows by user agent, headless browsers, Cloudflare Workers).
- **Good bots only by choice:** `(data)/crawlers/_allow-good.yaml` is shipped commented out; each entry pins the
  operator's published ranges.
- **Everyone else is challenged**, browser or not (`fast`, difficulty 4), so a scraper cannot skip the check with a
  non-browser user agent. The pass is a host-only, `HttpOnly`, `Secure`, `SameSite=Lax` cookie bound to the client
  address, valid 12 hours. `REDIRECT_DOMAINS` is the deployment's own host (unset, Anubis would redirect anywhere).
- `status_codes.DENY: 403`, because a subrequest proxy reads 2xx as "allowed".
- **Rate limiting** stays in the gateway (per address on these routes). Anubis has no rate limiter of its own; the
  proof-of-work makes each new pass cost the client CPU time.

**5. Logs.** Ops log only: JSON on stderr at `INFO`, under Docker's `local` driver capped at two 5 MB files. Each
decision is logged with its rule and the context Anubis always attaches (client address, user agent, Accept-Language,
host, method and path, never the query string), which is what is needed to investigate a scraper; `WARN` stops
per-request lines. Prometheus metrics stay inside the compose network, with no address in any label. Because Anubis's
challenge script sends the visitor's full original address, fragment included, back in the `pass-challenge` query,
Caddy's access log skips that request, so an auditor or supplier sign-in token is never written to a log.

**6. Mascot images: unchanged.** They are by CELPHASE and, per `web/static/img/ATTRIBUTIONS.txt` in the Anubis source,
under the repository's MIT licence; no trademark or branding rule is attached. The project offers unbranded use only
in its paid BotStopper build. So no neutral replacement is needed, and we do not fork or rebuild the image to swap them.
An organisation that cannot show them leaves the profile off.

**7. Accessibility.** A static review of v1.28.2's templates against DESIGN_GUIDELINES.md: page language and title set,
progress exposed as a labelled `progressbar`, reduced motion and colour scheme respected, no deadline on the default
challenge (we do not use the timed `metarefresh` challenge, WCAG 2.2.1). Two failures, both upstream: the challenge
needs JavaScript (a `<noscript>` message explains), and the challenge page's mascot image has no `alt` (WCAG 1.1.1).
So the interstitial does not meet our WCAG 2.2 AA floor in full. This is a further reason it is off by default; the
allow-list is the remedy for a named person, and we do not fork Anubis to fix its markup.

**Open source first (ADR-0176).** Anubis was named by the owner; the search record in `infra/THIRD_PARTY.md` compares it
with a Caddy rate-limit or WAF module (a custom Caddy build, and a rate limit does not tell a scraper from a person) and
third-party CAPTCHA services (rejected: they call out from the browser and the server, so they fail air-gapped and send
visitor data away). Our own code is configuration only: the Caddy gate, the policy, the compose service and the
installer switch.

## Consequences

- An admin can put a proof-of-work check in front of the public pages with one installer flag, without touching the
  authenticated product, and with the gateway's view of client addresses unchanged.
- **Real users pay when it is on:** a locked-down browser can fail it, and the interstitial is below our accessibility
  floor (two upstream failures). The allow-list and the off default are the mitigations; the deployment doc says so.
- **The pass cookie can expire inside an open page.** A public page's background `fetch` to `/v1/trust-center`,
  `/v1/auditor/*` or `/v1/supplier/*` then follows the 307 to the challenge's HTML and fails. The UI need (the public
  pages should treat that answer as "reload to repeat the check") is posted on #453; this ADR changes no UI.
- **An auditor or supplier sign-in token passes through Anubis once.** The challenge script carries the original
  address's fragment into the `pass-challenge` query, so the token reaches the Anubis container. Anubis logs the path
  only and Caddy skips that request in its access log; the token is single-use and redeemed seconds later.
- Behind `--tls none` or on Kubernetes the customer wires their own proxy to the hook; a misconfigured proxy that
  checks more than the public paths would challenge API clients. The doc names the paths and the 2xx rule.
- One replica, in memory: a restart drops passes and challenges in flight (visitors re-solve). More replicas need a
  shared signing key and store, which is documented, not shipped.
- Follow-ups: the #453 UI item above; re-check upstream for an `alt` fix and re-pin; an in-app audit record of the
  deployment choice would need a gateway-readable flag, not built here.

## As built (2026-11-07)

- `infra/anubis/policy.yaml`, `infra/anubis/allowlist.yaml` (a documentation address only, RFC 5737),
  `infra/anubis/k8s/anubis.yaml`.
- `infra/caddy/routes.Caddyfile`: the gateway proxy moved into a shared `regulait_gateway_proxy` snippet, used by the
  catch-all and by the gate; `regulait_public_gate_off` (Anubis's path answers 404) and `regulait_public_gate_on`.
- `docker-compose.yml`: service `anubis` (profile `anubis`, no published port, read-only, `cap_drop: [ALL]`,
  `no-new-privileges`, 128 MB) and `REGULAIT_ANUBIS` on both fronts.
- `scripts/install.sh` (`--anubis`, `--no-anubis`, the air-gapped tag and image-id check) and
  `scripts/build-image-bundle.sh --with-anubis`.
- `docs/deployment/ANUBIS.md`; `infra/THIRD_PARTY.md` row and search record.
- Tests: `scripts/anubis-public-pages.test.mjs` (compose, the gate's paths and headers, the policy's air-gapped and
  non-2xx rules, the image pins, and the installer's `--check` rendering); the tunnel front test now counts headers in
  the two upstream blocks only, and the bundle test accepts the optional Anubis references. Neither Caddy nor Anubis
  was executed in this session; the Caddyfile and policy were written against Caddy 2.11's and Anubis 1.28.2's
  documented syntax and Anubis's config structs, and need a live run before the first deployment that turns it on.
- No migration.

## Review round 1 (2026-11-08, #729)

- **Security (blocking), fixed:** Anubis sets no Content-Security-Policy and its pages are same-origin with the portals.
  Caddy now sets the strictest CSP Anubis documents as working (v1.28.2 `content-security-policy` advice, plus
  `frame-ancestors 'none'`) on `/.within.website/*` (replacing), and the same CSP set-if-absent on the public paths, so
  Anubis's relayed 403 page gets it and the gateway's own CSP on allowed responses is unchanged. Pinned in
  `scripts/anubis-public-pages.test.mjs`.
- **Security (non-blocking), done:** the Kubernetes hook gains a NetworkPolicy: ingress only from pods labelled
  `regulait.io/anubis-client: "true"` to 8923, no egress, so the metrics port is closed.
- **Code (non-blocking):** the unescaped `redir={uri}` (a second query parameter is lost on return) is documented in
  ANUBIS.md rather than changed, because Caddy has no URL-escaping placeholder for the whole request URI and the public
  pages keep their tokens in the fragment. A live smoke test (401 → 307 → challenge; a blocked user agent → 403) and
  adding the Anubis image to the Trivy image-scan matrix are follow-ups: the first needs a host that can run the stack,
  the second is a security-workflow change outside this lane.

