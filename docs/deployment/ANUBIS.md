# Optional bot check for the public pages (Anubis)

[ADR-0258](../../internal/decisions/0258-anubis-public-pages.md) adds **Anubis** (TecharoHQ/anubis v1.28.2, MIT) as an
optional proof-of-work check in front of RegulAIt's **public pages only**: the trust centre
([ADR-0225](../../internal/decisions/0225-outward-trust-pages.md)), the auditor portal (same ADR) and the supplier portal
([ADR-0221](../../internal/decisions/0221-supplier-portal.md)). It never sits in front of the admin console, the product
API or the gateway's model and MCP routes.

**It is off by default.** Turning it on is a deployment choice for an admin, and you should record it (below). The check
costs real people something: an auditor or supplier on a locked-down browser (JavaScript disabled, a strict script
blocker, some assistive setups) can fail the challenge and be unable to reach the portal you invited them to. The
[allow-list](#allow-listing-a-named-auditor-or-supplier) is the way round that.

## What it does

```
browser --HTTPS--> Caddy (TLS or tunnel front) --+--> gateway:3000      (every route, as today)
                                                 |
           only for the public pages, first:  forward_auth --> anubis:8923  (yes / challenge / deny)
           and /.within.website/* (the challenge page)  ----> anubis:8923
```

- **Covered paths:** `/ui/trust`, `/ui/audit`, `/ui/supplier` (and anything below them), `/v1/trust-center`,
  `/v1/auditor/*`, `/v1/supplier/*`.
- **Caddy stays the only proxy to the gateway.** Anubis runs in subrequest mode: it only answers Caddy's question, so the
  gateway still sees the front's fixed address and the client address the front vouches for (ADR-0031), and Anubis has
  no route to the gateway at all.
- **Known scrapers are refused** (HTTP 403): every AI/LLM crawler, training and search fetcher Anubis knows by user agent,
  headless browsers, Cloudflare Workers and other pathological clients (`infra/anubis/policy.yaml`).
- **Everyone else solves a short proof-of-work** in the browser (difficulty 4, usually a second or two) and gets a signed
  pass cookie: host-only, `HttpOnly`, `Secure`, `SameSite=Lax`, bound to their address, valid 12 hours. Non-browser
  clients are challenged too, so a scraper cannot skip the check by changing its user agent.
- **Rate limits** stay where they are: the gateway limits the public routes per address (ADR-0221, ADR-0225), and those
  limits still apply behind Anubis. Anubis has no rate limiter of its own; the proof-of-work makes each new pass cost the
  client CPU time.
- **Search engines are not let in** unless you choose to (below).
- **Air-gapped:** nothing is downloaded at run time. The policy uses no GeoIP or ASN lookups, no DNS blocklist, no
  remote address lists and no Open Graph fetches. The image is pinned by digest and can travel in the image bundle.

## Turning it on

With the installer (needs `--tls letsencrypt` or `--tls internal`, because the check lives in Caddy's routes):

```sh
./scripts/install.sh --mode byoc --domain regulait.acme.example --tls letsencrypt --anubis
```

It writes `REGULAIT_ANUBIS=on` to `.env` and starts the `anubis` compose profile. Re-runs keep the choice;
`--no-anubis` turns it off again.

Air-gapped: build the bundle with `--with-anubis` and install with `--anubis`:

```sh
./scripts/build-image-bundle.sh --version 0.1.0 --with-anubis --out regulait-images-0.1.0.tar
./scripts/install.sh --mode air_gapped --domain regulait.corp.local --tls internal \
                     --version 0.1.0 --image-bundle regulait-images-0.1.0.tar --anubis
```

By hand with compose: set `REGULAIT_ANUBIS=on` in `.env` and add `--profile anubis` to the profile you already use
(`tls`, `hosted` or `tunnel`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `REGULAIT_ANUBIS` | `off` | `on` puts the check in front of the public pages. Any other value stops Caddy from starting. |
| `REGULAIT_ANUBIS_ALLOWLIST_FILE` | `./infra/anubis/allowlist.yaml` | your allow-list (below), mounted read-only |
| `REGULAIT_ANUBIS_CONTACT_EMAIL` | empty | shown on Anubis's error page, so a blocked visitor knows whom to ask |

`REGULAIT_ANUBIS=on` without the `anubis` profile makes the public pages answer 502: they fail closed, they are not
exposed without the check. The profile without `on` runs Anubis but never asks it.

**Record the choice.** In your deployment record, note who turned it on, when, why, and the allow-list entries in force.
The setting is a deployment file, not an in-app setting, so the product's audit log does not see it.

## Allow-listing a named auditor or supplier

Ask them for the egress addresses their browser uses (their office or VPN range), then add an entry to your copy of
the allow-list and point `REGULAIT_ANUBIS_ALLOWLIST_FILE` at it:

```yaml
- name: auditor-example-llp
  action: ALLOW
  remote_addresses:
    - 203.0.113.10/32
```

Restart the `anubis` service. Requests from those addresses skip the challenge; the portal still authenticates them by
their single-use sign-in link. Keep ranges narrow (never a whole cloud provider), record who asked and until when, and
remove the entry when the engagement ends.

## Allowing good bots

Off unless you choose it. To let search engines and the Internet Archive index the public trust centre, uncomment the
`(data)/crawlers/_allow-good.yaml` import in `infra/anubis/policy.yaml` (each entry pins the operator's published address
ranges, so a spoofed user agent alone does not pass) and record the choice.

## Logs and metrics

- **Ops log:** JSON on the container's stderr (`docker compose logs anubis`), under a bounded `local` log driver (two
  5 MB files). At the default `INFO` level each decision is logged with its rule: `explicit deny`, `new challenge
  issued`, `challenge accepted`. Anubis attaches the request context it always logs: client address, user agent,
  Accept-Language, host, method and **path only** (never the query string). That is the minimum needed to investigate a
  scraper; set `logging.level: WARN` in the policy to stop per-request lines.
- **Metrics:** Prometheus counters per rule and action on port 9090 inside the compose network (no published port), with
  no client address in any label.
- **Caddy's access log** does not record Anubis's `pass-challenge` request. The auditor and supplier sign-in links keep
  their single-use token in the URL fragment, which no server receives, but Anubis's challenge script sends the full
  address of the page the visitor asked for, fragment included, back in that request's query. The token is single-use
  and is redeemed seconds later; it is still kept out of the logs.

## Accessibility (checked against DESIGN_GUIDELINES.md)

The challenge page is Anubis's own, not ours, and we ship it unmodified. A static review of v1.28.2's templates found:

| Check | Result |
| --- | --- |
| Page language (`<html lang>`), page title | Pass: set from the visitor's language |
| Progress announced to assistive technology | Pass: `role="progressbar"` labelled by the status text |
| Works without JavaScript | **Fail:** the proof-of-work needs JavaScript; a `<noscript>` message says so. Remedy: the allow-list. |
| Text alternative for images (WCAG 1.1.1) | **Fail:** the mascot image on the challenge page has no `alt`, so a screen reader may read its file name. The error page's image has `alt`. |
| `prefers-reduced-motion`, light and dark | Pass: the stylesheet animates only under `no-preference` and follows the colour scheme |
| Time limit (WCAG 2.2.1) | Pass for the default challenge, which continues on its own with no deadline. We do not use the `metarefresh` challenge, which redirects on a timer. |

So the page does not meet our WCAG 2.2 AA floor in full. That is one more reason the profile is off by default. The two
failures are upstream; we have not forked Anubis to fix them.

## The mascot images

The challenge pages show Anubis's mascot images (by CELPHASE). They are under the repository's MIT licence
(`web/static/img/ATTRIBUTIONS.txt` in the Anubis source), with no trademark or branding rule attached, so we ship them
unchanged rather than build our own image. The open-source build cannot swap them without a rebuild; Techaro's paid
BotStopper edition can. If your organisation cannot show them on a compliance page, leave the profile off.

## Your own proxy or Kubernetes

If you terminate TLS on your own proxy (`--tls none`), or run on Kubernetes, run Anubis beside your proxy instead.
`infra/anubis/k8s/anubis.yaml` is a pinned single-replica Deployment and ClusterIP Service in subrequest mode, with the
same settings as the compose profile. Then configure your proxy's external-authorisation hook (nginx `auth_request`,
Traefik `forwardAuth`, Caddy `forward_auth`; see Anubis's "Subrequest Authentication" documentation) **on the public paths
above only**, route `/.within.website/*` to the Service, set `X-Real-IP` to the client address your proxy vouches for,
and strip any client-sent `X-Original-Uri`. Anubis's deny answer must be a non-2xx status (the policy sets `DENY: 403`),
or a proxy that treats 2xx as "allowed" would let a denied scraper through.

## Turning it off

`./scripts/install.sh --no-anubis` (or `REGULAIT_ANUBIS=off` and drop `--profile anubis`), then record it. Pass cookies
already issued are simply ignored.
