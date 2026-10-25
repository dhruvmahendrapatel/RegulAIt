# Third-party components — deployment infrastructure (`infra/`, `docker-compose.yml`)

Container images the compose stack runs beside our own image. They are pulled by digest (pinned in
`docker-compose.yml`), carried in the air-gapped image bundle, and download nothing at run time unless stated.

| Component | Version | Licence | Used by | Why |
|---|---|---|---|---|
| Caddy (`caddy:2.11.7-alpine`, digest in the `x-caddy` anchor) | 2.11.7 (released 2026-10) | Apache-2.0 | `caddy` service (profiles `tls` and `hosted`), `executor-front` (profile `isolation`) | TLS termination with automatic ACME certificates (ADR-0029, ADR-0202 lane H) and the executor's internal TLS front (ADR-0190). On a connected host it calls the ACME directory (Let's Encrypt) to issue and renew; with `tls internal` (air-gapped, local proof) it uses its own local CA and makes no outbound call. |

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
