# Third-party components — deployment infrastructure (`infra/`, `docker-compose.yml`)

Container images the compose stack runs beside our own image. They are pulled by digest (pinned in
`docker-compose.yml`), carried in the air-gapped image bundle, and download nothing at run time unless stated.

| Component | Version | Licence | Used by | Why |
|---|---|---|---|---|
| Caddy (`caddy:2.11.7-alpine`, digest in the `x-caddy` anchor) | 2.11.7 (released 2026-10) | Apache-2.0 | `caddy` service (profiles `tls` and `hosted`), `executor-front` (profile `isolation`) | TLS termination with automatic ACME certificates (ADR-0029, ADR-0202 lane H) and the executor's internal TLS front (ADR-0190). On a connected host it calls the ACME directory (Let's Encrypt) to issue and renew; with `tls internal` (air-gapped, local proof) it uses its own local CA and makes no outbound call. |
| cloudflared (`cloudflare/cloudflared:2026.10.7`, digest in `docker-compose.yml`) | 2026.10.7 (image built 2026-10-30; from 2026.10.6 on 2026-11-06, Dependabot #685) | Apache-2.0 | `cloudflared` service (profile `tunnel`) | The laptop-hosted demo's outbound-only tunnel to Cloudflare's edge (ADR-0203 lane T, docs/deployment/TUNNEL.md). It connects out to Cloudflare (port 7844, QUIC or HTTP/2) with a remotely managed tunnel token and accepts no inbound connection. Not part of the air-gapped bundle: a tunnel to a public edge is meaningless air-gapped. `--no-autoupdate`, so the pinned digest is the version that runs. |
| Anubis (`ghcr.io/techarohq/anubis:v1.28.2`, digest in `docker-compose.yml` and `infra/anubis/k8s/anubis.yaml`) | 1.28.2 (released 2026-10-23) | MIT (the mascot images too: `web/static/img/ATTRIBUTIONS.txt` upstream) | `anubis` service (profile `anubis`, off by default) | Optional proof-of-work bot and AI-scraper check in front of the public trust centre, auditor portal and supplier portal only (ADR-0258, docs/deployment/ANUBIS.md). Subrequest mode: Caddy asks it and proxies to the gateway itself. Downloads nothing at run time: the policy uses no GeoIP/ASN service, DNS blocklist, remote address list or Open Graph fetch. Runs as uid 1000, read-only, no published port. |
| terraform-aws-modules/vpc (`terraform-aws-modules/vpc/aws`, and its `modules/vpc-endpoints`) | 6.7.3 | Apache-2.0 | `infra/environments/demo-host/host` (Terraform only; nothing ships in the product) | The demo host's dedicated VPC: private and public subnet, one NAT gateway, flow logs to a KMS-encrypted log group, the default security group taken over with no rules, and the interface and gateway VPC endpoints (ADR-0228). Pinned by exact version and the stack's lock file; downloaded by `terraform init` on the operator's machine, never at run time. |

## Search record (ADR-0176)

Reverse proxy with automatic certificates for the hosted demo, 2026-10-25 (ADR-0202 lane H). The repository already
ran Caddy for ADR-0029; the comparison was re-checked before reusing it:

- **Caddy** 2.11.7 (Apache-2.0, released 2026-10): kept. Built-in ACME issuance and renewal with HTTP-01 on :80,
  automatic HTTP to HTTPS redirect, one static config file with environment placeholders, already pinned by digest
  and in the air-gapped bundle.
- **Traefik** (MIT, actively maintained): viable, not chosen. It also issues ACME certificates, but would replace a
  working, audited config for no gain; its configuration is label- or provider-driven, a second idiom in this stack.
- **nginx** (BSD-2-Clause) plus **certbot** (Apache-2.0): not chosen. Two components and a renewal timer and reload
  hook to own, where Caddy does both in one process.
- **HAProxy**: rejected. GPL-2.0, not on the ADR-0176 licence list.

Outbound tunnel for the laptop-hosted demo, 2026-10-26 (ADR-0203 lane T; owner decision on #453: a Cloudflare Tunnel,
DNS on Cloudflare, no inbound ports, Cloudflare-provided HTTPS):

- **cloudflared** 2026.10.3 (Apache-2.0, released 2026-10-21, monthly releases; now 2026.10.7): chosen. It is the connector for the
  service the owner chose; nothing else speaks Cloudflare's tunnel protocol. Official image, pinned by digest, runs
  as a non-root user; a remotely managed tunnel needs only a token, so no credentials file or config file is
  written to disk.
- No routing of our own was written: the tunnel hands requests to the existing Caddy (above), which reuses the TLS
  front's routes file (`infra/caddy/routes.Caddyfile`).

Bot and AI-scraper check for the public pages, 2026-11-07 (ADR-0258, backlog P34; the owner named Anubis):

- **Anubis** 1.28.2 (MIT, TecharoHQ, releases every few weeks; v1.28.2 tagged 2026-10-22): chosen. Proof-of-work
  challenge with maintained user-agent rule sets for AI crawlers, a subrequest mode that fits Caddy's `forward_auth`, a
  local-only policy file and an official image pinned by digest. osv.dev lists no advisory affecting 1.28.2 (queried
  2026-11-07; the two known ones, GHSA-cf57-c578-7jvv and GHSA-6wcg-mqvh-fcvg, do not affect it).
- **Caddy rate limiting or a WAF module**: not chosen. Rate limits already exist in the gateway for these routes, and a
  rate limit does not tell a scraper from a person; Caddy's rate-limit module is a third-party plugin and would mean a
  custom Caddy build.
- **CAPTCHA services** (hCaptcha, Turnstile, reCAPTCHA): rejected. Each calls a third-party service from the visitor's
  browser and our server, which fails air-gapped and sends visitor data out.
- **BotStopper** (Techaro's paid build of Anubis): not chosen. It only adds custom branding and private support; the
  open-source images are MIT with no branding rule, so the stock image is used unchanged.

VPC for the AWS demo host, 2026-11-01 (ADR-0228, security-team addendum):

- **terraform-aws-modules/vpc** 6.7.3 (Apache-2.0, the most used community VPC module, releases monthly): chosen. It
  covers subnets, NAT, flow logs with a KMS-encrypted log group and IAM role, default-security-group takeover, and the
  endpoints submodule, which would otherwise be about 150 lines of hand-written resources.
- **Hand-written `aws_vpc` and friends**: not chosen. That is a solved problem (ADR-0176 rule 2).
