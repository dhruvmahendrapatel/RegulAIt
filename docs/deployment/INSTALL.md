# Installing RegulAIt in your own environment

One command, three modes, no hand-assembled environment variables. This is the operator guide
for [ADR-0041](../decisions/0041-byoc-primary-motion.md)'s productised install.

```sh
./scripts/install.sh --mode byoc --domain regulait.acme.example --tls letsencrypt
```

Everything else on this page is detail about *which* flags and *why*.

---

## Before you start: the one thing that cannot be recovered

`REGULAIT_DATA_KEY` is a 32-byte AES-256-GCM key. Every stored connector token, model API key
and TOTP secret in the database is ciphertext under it (`apps/gateway/src/secrets.ts`).

**If you lose it, a restore onto a new machine recovers every user, every audit row, every
project — and leaves every credential permanently undecryptable.** There is no recovery path.
[ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md) calls this the sharpest edge in the stack,
and it is not exaggerating.

The installer therefore:

- **refuses to run on a weak key** — not 64 hex characters, the published dev default, fewer than
  8 distinct hex characters, or any short block repeated to length;
- **generates one if you did not supply one**, prints it in a banner, and (interactively) will not
  proceed until you type `recorded`;
- writes it to `<install-dir>/.env` and **nowhere else**.

Record it somewhere whose failure is independent of this host's disk: a password manager, an SSM
Parameter Store `SecureString` under a *different* KMS key, an offline safe. Putting it in the same
S3 bucket as your database backups defeats the entire envelope split.

Generate one yourself with `openssl rand -hex 32`.

### After the first boot: check the fingerprint and attest it (ADR-0063)

The gateway derives a **non-secret fingerprint** of the key (`dk1:` + 32 hex, a truncated HMAC —
it identifies the key and reveals nothing about it), records it, and prints it at every boot:

```
data key:  dk1:3f2a9c11d0be47e5a8c6210fb47d9e02 [recorded] — NO CUSTODY ATTESTATION ON FILE — …
```

Two things follow:

1. **That string goes into every backup** (S3 object metadata `datakey`, and
   `manifest.json` → `data_key_fingerprint`), so a future restore can check *before* restoring
   whether the key on hand is the right one.
2. **Starting the gateway with a different key against this database will REFUSE**, naming both
   fingerprints. That is the point — see [ADR-0063](../decisions/0063-data-key-custody.md).

Once the key is filed somewhere that is not this machine, say so. This is the step that turns the
banner into a record:

```bash
curl -sS "$API/v1/security/data-key/attestations" \
  -H "Authorization: Bearer <admin key>" -H 'Content-Type: application/json' \
  -d '{"method":"password_manager","locationHint":"1Password vault: Platform Ops","confirmRecordedOutOfBand":true}'
```

or **Admin → Settings → Data key custody**. RegulAIt records your *claim*; it cannot verify custody
and does not pretend to. What it does guarantee is that until somebody makes that claim, every
backup run reports `custody=UNATTESTED` and the portal shows an alarm — because an unattested
backup is a backup that may not be restorable.

---

## Requirements

| | |
| --- | --- |
| Docker Engine | any version with the **`docker compose` v2 plugin**. `docker-compose` v1 is not supported — the stack uses profiles, IPAM `ip_range` pinning and `pull_policy`, none of which v1 understands. |
| Disk | ≥ 5 GiB free on the Docker root (image layers + the Postgres volume + room for a `pg_dump`). Override with `--min-disk-gb`. |
| Ports | 3000 on loopback, plus 80 and 443 unless `--tls none`. |
| openssl | for key generation and update-bundle verification. |

The installer preflights all of these and refuses rather than half-installing.

---

## The three modes

| flag | what it means | TLS default |
| --- | --- | --- |
| `--mode hosted` | a single-tenant instance we happen to operate for you — an evaluation on-ramp, **not** shared SaaS ([ADR-0041](../decisions/0041-byoc-primary-motion.md) §3) | `letsencrypt` |
| `--mode byoc` | your cloud account, your IAM, your key. **The primary motion.** | `letsencrypt` |
| `--mode air_gapped` | no outbound internet at all | `internal` (Let's Encrypt is **refused**) |

`--mode` records installer-level metadata in `.env`. It is **not** the same thing as
[ADR-0015](../decisions/0015-byoc-deploy-modes-data-boundary.md)'s deploy-target mode, which is a
column on each `deploy_targets` row and is what the code enforces the data boundary against. Both
exist; do not confuse them. `.env` says so in a comment.

`SEED_DEMO` defaults to **0** for `byoc` and `air_gapped` (a customer database must not sprout demo
users `dana`/`avery`/`admin` with printed API keys) and **1** for `hosted`. Override with
`--seed-demo` / `--no-seed-demo`.

---

## TLS

| flag | issuer | outbound? | when |
| --- | --- | --- | --- |
| `--tls letsencrypt` | real Let's Encrypt via Caddy's automatic HTTPS | **yes** — ACME, plus an inbound HTTP-01 challenge on :80 | a publicly resolvable hostname |
| `--tls internal` | Caddy's own local CA | **no** | air-gapped, or any internal-only host |
| `--tls none` | none — the gateway binds 127.0.0.1:3000 only | no | you terminate TLS on your own proxy |

With `--tls internal`, browsers will warn until you distribute Caddy's root certificate:

```sh
docker compose -p regulait cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./regulait-root.crt
```

With `--tls none`, set `REGULAIT_TRUSTED_PROXIES` in `.env` to **your** proxy's address.
[ADR-0031](../decisions/0031-p0-hardening-streaming-exports-proxy-trust-rate-limits-csp.md) makes
this the only peer allowed to speak for the client via `X-Forwarded-*`, and `req.ip` lands on every
`auth_sessions` row — it is the attribution pillar 1 sells. Never widen it to a range.

---

## Dry run first

`--check` runs the **entire** preflight and render path and stops before touching any container:

```sh
./scripts/install.sh --check --mode byoc --domain regulait.acme.example \
                     --tls letsencrypt --dir /tmp/regulait-plan
```

It writes `.env`, `compose.install.yml` and `.regulait-version` into `--dir`, validates the
resolved compose configuration, and prints the exact `docker compose … up -d` it would have run.

Rendering is **deterministic** — there is no timestamp in the output — so running it twice and
diffing is a real idempotency check, and you can diff two modes against each other to see exactly
what differs.

---

## Air-gapped: the pre-seeded image bundle

`docker compose up --build` pulls `node:22-slim` from Docker Hub and runs
`pnpm install --frozen-lockfile` against the npm registry. Both are internet. **An air-gapped host
cannot build; it can only run images loaded from a file.** That is why the air-gapped path passes
`--no-build` and refuses to start without the images present.

**On a connected host:**

```sh
./scripts/build-image-bundle.sh --version 0.1.0 --out regulait-images-0.1.0.tar
sha256sum regulait-images-0.1.0.tar        # record this; the tar is not self-verifying
```

It builds `regulait/gateway:0.1.0` and saves it together with `postgres:16` and `caddy:2-alpine`.
The tag and the `--version` you pass to the installer must be the **same string** — the generated
override pins `image: regulait/gateway:<version>` with `pull_policy: never`.

**Carry the tarball across the boundary**, then on the air-gapped host:

```sh
./scripts/install.sh --mode air_gapped \
                     --domain regulait.corp.local \
                     --tls internal \
                     --version 0.1.0 \
                     --image-bundle /media/usb/regulait-images-0.1.0.tar
```

If integrity across the gap matters (it should), ship the image tarball **inside a signed update
bundle** rather than loose:

```sh
./scripts/build-update-bundle.sh --version 0.1.0 --key ~/offline/release.pem \
    --include dist/regulait-images-0.1.0.tar --include docker-compose.yml --include scripts
```

See [UPGRADE.md](UPGRADE.md).

What the air-gapped path guarantees, and what it does not, is written out per-surface in
[DATA_BOUNDARY.md](DATA_BOUNDARY.md) — **including §4, which is a real gap you should read before
you rely on the word "air-gapped".**

---

## What re-running does

The installer converges. It never destroys.

- Every secret already in `<install-dir>/.env` is **preserved**, not regenerated. Regenerating the
  data key would brick every stored credential; regenerating the Postgres password would lock the
  gateway out of its own database, because `POSTGRES_PASSWORD` is only honoured on *first* initdb.
- Every flag you do not repeat is read back from the existing `.env`, so
  `./scripts/install.sh --dir /opt/regulait --yes` re-converges an installed box with no arguments.
- Rendered files are compared before writing; unchanged files are left alone and reported as
  `unchanged`.
- All state lives in Docker named volumes (`regulait_pgdata`, `regulait_caddy_data`,
  `regulait_caddy_config`). The install directory holds configuration only.

Reconfiguring is therefore just another run:

```sh
./scripts/install.sh --dir /opt/regulait --domain new.acme.example --tls letsencrypt --yes
```

---

## After the install

The installer prints all of this; it is repeated here so it is findable later.

### 1. Create the first admin, then close the bootstrap door

`REGULAIT_BOOTSTRAP_TOKEN` authenticates as an admin **with no user identity**
(`apps/gateway/src/auth.ts`). It exists to create the first real admin and nothing else.

```sh
curl -sS https://your-host/v1/users \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","email":"admin@your.org","isAdmin":true}'

sed -i '/^REGULAIT_BOOTSTRAP_TOKEN=/d' /opt/regulait/.env
docker compose -p regulait up -d
```

### 2. Wire your IdP

OIDC providers are **database rows**, not environment variables — `--oidc-issuer` only records what
you installed against and prints the calls to make.
[ADR-0043](../decisions/0043-mcp-oidc-egress-guard.md) puts the issuer URL behind the egress guard,
so the host needs an allow-list entry **first** or discovery is refused. (That refusal is the guard
working.)

```sh
curl -sS https://your-host/v1/egress/hosts -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"host":"keycloak.acme.example","note":"OIDC issuer"}'

curl -sS https://your-host/v1/auth/oidc/providers -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"issuerUrl":"https://keycloak.acme.example/realms/corp","clientId":"…","clientSecret":"…"}'
```

SAML is the same shape (`--saml-entity-id`, `--saml-clock-skew` pin the SP side) but makes **no**
server-to-server call at all — it is redirect/POST-binding through the browser.

### 3. Set up backups before you have data worth losing

See [BACKUP_RESTORE.md](BACKUP_RESTORE.md). The short version: the entire database is one Docker
volume, and [ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md)'s verified nightly `pg_dump` is
the only thing standing between you and losing it.

### 4. Know what leaves the box

[DATA_BOUNDARY.md](DATA_BOUNDARY.md), per mode, with the greps to verify it yourself.

### 5. Read the logs (ADR-0167)

The gateway logs structured JSON lines to stdout (`docker compose logs gateway`; the compose file
caps the file at 5 × 50 MB). Every refused request (401/403/404/429) is one `warn` line with the
route, method, client IP and the **kind** of credential presented (never the credential); every
5xx is an `error` line with the stack. Credentials in request headers (`authorization`, `cookie`,
`x-api-key`) and `set-cookie` are redacted before anything is written.

| Variable | Effect |
|---|---|
| `LOG_LEVEL` | `fatal` … `trace`; default `info`. `warn` keeps only refusals and failures. |
| `REGULAIT_LOG=off` | Silences the process entirely (the boot posture block still says so). |
| `DEBUG_ERRORS=1` | Additionally prints every unhandled 500 to stderr, even with logging off — a dev convenience, not a log. |

The boot posture block (`proxy / hsts / egress / data key / bootstrap / secrets / database /
logging / scheduler`) is printed once at startup; `secrets: DEV-GRADE` lines mean the
published compose defaults are in use, and a deployment with `REGULAIT_DEPLOY_MODE` or
`REGULAIT_HSTS` set **refuses to start** on them (override, if you really mean it, with
`REGULAIT_ALLOW_DEV_SECRETS=1`).

Do not set `REGULAIT_OFFLINE_CHECKS` on an install. It is the demo's declaration that a workflow
check nobody reported may be auto-passed (labelled) where a template opts in; unset — and always
on a box with `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` set — such checks stay pending until CI
reports them (ADR-0167 amendment, AER-047). With `SEED_DEMO=1` (the compose default) the seeder
declares it for its own run only, so the seeded *demo* pipelines show auto-passed checks.

---

## Full flag reference

`./scripts/install.sh --help`, or read the header of `scripts/install.sh` — the design notes that
matter (why re-runs preserve secrets, why the install directory is config-only, why air-gapped
never builds) are written there rather than only here.

## Troubleshooting

| symptom | cause |
| --- | --- |
| `port 80 is already in use` | something else terminates HTTP on the box. Use `--tls none` and put RegulAIt behind it, remembering to set `REGULAIT_TRUSTED_PROXIES`. |
| `the docker daemon is not reachable` | start it, or add your user to the `docker` group. `--check` still works without it. |
| `air_gapped mode cannot pull or build` | the image bundle step above was skipped, or the `--version` does not match the tag in the bundle. |
| gateway does not answer within 120 s | `docker compose -p regulait logs gateway`. First boot runs migrations, which on a cold volume takes longer than the probe window on slow disks — check the log rather than assuming failure. |
| `neither ss nor netstat is available` | the port check fell back to a loopback connect probe, or was skipped. Not fatal; verify manually. |
