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

`REGULAIT_DEMO_LICENSE` is the laptop demo's switch for a self-minted, not-for-production demo
licence (README, "Demo with your own password (Docker)"). It is **never** for an install. The
installer refuses to run while it is set in the environment or the `.env`, and the generated
`compose.install.yml` pins it to `"0"`.

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
  `regulait_caddy_config`, `regulait_install_secrets`). The install directory holds configuration
  only.
- An existing admin is never touched: the first-admin step is skipped, and a bootstrap token
  that is still live is retired. A retired token stays retired (see "The first admin" below).
- The install-generated receipt signing key is never regenerated or overwritten; an operator key
  passed with `--receipt-key-file` / `--receipt-key-id` is read back from `.env` like every other
  setting.

Reconfiguring is therefore just another run:

```sh
./scripts/install.sh --dir /opt/regulait --domain new.acme.example --tls letsencrypt --yes
```

---

## After the install

The installer prints all of this; it is repeated here so it is findable later.

### 1. The first admin (the installer asks for it)

Once the stack is up, the installer creates your first admin ([ADR-0194](../decisions/0194-installer-sets-first-admin.md)).
Interactively it asks for:

- a **username** (press Enter for `admin`);
- an **email**;
- a **password**, typed twice and not echoed. A mismatch asks again. The org password policy is
  checked before anything is created (by default at least 12 characters and 3 of lowercase,
  uppercase, digits and symbols); a password it refuses asks again.

The password is yours, so it is not a one-time password. It is never written to `.env`, a compose
file, a log, your shell history or the audit log. The installer hands it to the gateway container
on a pipe (`docker compose exec -T gateway node apps/gateway/dist/first-admin.js`), never as a
command argument. The account goes through the gateway's own validators, seat gate and audit rows
(`first-admin-created`, `username-set`, `initial-password-set`), in one transaction.

**Non-interactive installs** (`--yes`, CI, no terminal) put the password in a file instead:

```sh
# write it without echo and without it entering shell history (or have your secret tooling write it)
( umask 077; IFS= read -rs -p 'First admin password: ' pw; printf '%s' "$pw" > /root/first-admin-password )
REGULAIT_FIRST_ADMIN_PASSWORD_FILE=/root/first-admin-password \
REGULAIT_FIRST_ADMIN_EMAIL=admin@your.org \
REGULAIT_FIRST_ADMIN_USERNAME=admin \
  ./scripts/install.sh --dir /opt/regulait --yes ...
shred -u /root/first-admin-password
```

The file must be a regular file (not a symbolic link) owned by you or root, with mode `0600` or
stricter, holding one line: no control characters except one trailing newline, and no UTF-8
byte-order mark. Anything else is refused before anything renders, and checked again just before
use. `REGULAIT_FIRST_ADMIN_EMAIL` is required with it, and `--check` validates all
three. Without the file, a non-interactive install skips the step and says so.

**The bootstrap door closes itself.** `REGULAIT_BOOTSTRAP_TOKEN` authenticates as an admin **with
no user identity** (`apps/gateway/src/auth.ts`). As soon as an admin exists, the installer retires
it: the token is removed from `.env` (a `REGULAIT_BOOTSTRAP_RETIRED=1` line records that), it is
pinned to the empty string in `compose.install.yml`, and the gateway is restarted. It is pinned
rather than just deleted because `docker-compose.yml` would otherwise fall back to its published
dev default, which the gateway refuses to boot with. Re-runs keep it retired, and a token merely
exported in your shell is ignored. Only an explicit `--admin-token` on a run AFTER it was retired
re-opens it, for a break-glass recovery; the next run without that flag retires it again. On a
first install, `--admin-token` only chooses the token's value, and it is retired like any other
once the first admin exists. If retiring fails because the gateway cannot be restarted, the
installer stops and says so: the running gateway still accepts the old token until a re-run
succeeds.

With `--seed-demo`, the demo personas are created first, so the demo admin
(`admin@regulait.local`) is the existing admin and you are not asked for one. The summary says how
to replace it with your own account.

**Re-running** on a deployment that already has an active admin skips the step, changes no
account, and retires a token that is still live.

**To turn the account off later**, use the existing controls (each is audited):

- deactivate it (`POST /v1/users/:id/deactivate`) once another admin exists. The last active admin
  cannot be deactivated;
- or, once SSO is set up, make email sign-in `break_glass_only` or `sso_only` in Admin → SSO.

#### Fallback: create the first admin by hand

If the step was skipped or failed, the bootstrap token is still live and the summary prints it.
Create the admin with it, issue a one-time password, then **re-run the installer**: it sees the
admin and retires the token.

```sh
curl -sS https://your-host/v1/users \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@your.org","displayName":"Admin","isAdmin":true}'

curl -sS -X POST https://your-host/v1/users/<id>/set-initial-password \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN"

./scripts/install.sh --dir /opt/regulait --yes   # retires the bootstrap token
```

Do not just delete the token line from `.env` by hand: without the installer's override pin,
compose substitutes the dev default and the gateway refuses to start.

A fresh install starts strict (ADR-0181). The admin's first browser sign-in enrols a TOTP
authenticator before anything else opens, because MFA is required for admins. Passwords need three
character classes, an idle session ends after 30 minutes, and an API key issued without an expiry
lasts 90 days, with a ceiling of 365. Approver delegation is off. An admin can relax each of these
in the admin portal or through `PUT /v1/org/settings`, and the audit row records the old and new
values. An OIDC provider with JIT provisioning must name its allowed email domains, and a SAML
provider requires a signed response unless an admin turns that off for an IdP that signs only the
assertion.

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

### The receipt signing key (ADR-0189 R25)

Every sign-off takes a signed AI BOM snapshot, so a sign-off is refused while no usable receipt
signing key exists (409 `bom_signing_unavailable` with no key, 503 `receipt_signing_key_invalid`
with one that cannot be used). The install creates one for you:

- **First boot** of the gateway generates an Ed25519 key when no key is configured. It is written to
  `REGULAIT_INSTALL_SECRETS_DIR` (`/app/install-secrets` in the image, on the named volume
  `regulait_install_secrets`) as `receipt-signing-key.pem`, mode `0600`, owned by the gateway's
  `node` user. The installer runs the same generator after the stack is up and prints the result.
- It is **idempotent and never overwrites**: a second boot, or the installer, reuses the existing
  key. Two gateways booting at once end with one key (the file is published with a create-exclusive
  link). A temporary file left by a crashed generation is removed once it is a minute old.
- **What the gateway accepts** (POSIX): the key is opened without following symlinks and checked
  on the open file. It must be a regular file with mode `0600` or stricter, owned by the gateway's
  user, with exactly one hard link, in a directory owned by that user with no group or other access.
  Anything else is left untouched, reported as `invalid`, and sign-offs stay refused.
- **Use the default named volume.** A directory on a Windows or other non-POSIX filesystem mounted
  into Linux (drvfs/WSL, 9p, SMB/CIFS) reports group and other permissions or a foreign owner, so the
  key there is `invalid` (fail closed). A gateway running natively on Windows skips the mode and
  owner checks, because Windows has no such bits.
- The private key is **never** logged or returned by any API. The boot log, the installer and the
  posture read show only the key id (`install-ed25519-<hex>`, derived from the public key) and the
  public-key fingerprint (`sha256:` over the SPKI DER).
- If generation fails (an unwritable volume, for example) the boot log's `receipt key:` line says
  `INSTALL KEY GENERATION FAILED`, the gateway still starts, and sign-offs stay refused until a key
  exists.
- The first time a key signs anything it is registered in `receipt_signing_keys` and an audit row
  `receipt-signing-key-registered` records its key id, fingerprint and source
  (`install_generated` or `operator_managed`), in the same transaction, once per key.

Check which key is in use:

```sh
curl -sS https://your-host/v1/org/posture -H "Authorization: Bearer $ADMIN_KEY" | jq .receiptSigningKey
curl -sS https://your-host/v1/receipts/status -H "Authorization: Bearer $ADMIN_KEY" | jq .signingKey
```

`state` is one of `install_generated`, `operator_managed`, `missing` or `invalid`. It is reported
beside the posture controls, not as one of them: it never counts toward `hardened` and blocks
nothing by itself.

**Verifiers** fetch the public keys from `GET /v1/receipts/keys` (every key that ever signed,
with `firstUsedAt` and `retiredAt`); `GET /v1/receipts/export` carries the same keys with the
receipts, and `scripts/verify-receipts.mjs` checks a bundle offline.

**Switching to a key you manage.** Generate the key off the gateway host, make it readable by
uid 1000 (the container's `node` user), and re-run the installer with both flags:

```sh
openssl genpkey -algorithm ed25519 -out /etc/regulait/receipt-signing-key.pem
chown 1000:1000 /etc/regulait/receipt-signing-key.pem && chmod 600 /etc/regulait/receipt-signing-key.pem
./scripts/install.sh --dir /opt/regulait --yes \
  --receipt-key-file /etc/regulait/receipt-signing-key.pem --receipt-key-id acme-receipts-2026
```

- The path may use only `A-Z a-z 0-9 . _ / @ + -` and must be absolute. The key id may use only
  `A-Z a-z 0-9 . _ : -`, up to 128 characters. The installer warns when the file is not owned by
  uid 1000.
- The installer records both values in `.env` (`REGULAIT_RECEIPT_KEY_HOST_FILE`,
  `REGULAIT_RECEIPT_KEY_HOST_ID`), bind-mounts the file read-only at
  `/run/secrets/regulait-receipt-signing-key`, and sets `REGULAIT_RECEIPT_SIGNING_KEY` and
  `REGULAIT_RECEIPT_SIGNING_KEY_ID` for the gateway in `compose.install.yml`.
- After the stack is up the installer loads the key **inside the container**, exactly as a sign-off
  does. If the gateway cannot use it (for example a root-owned `0600` file, which the `node` user
  cannot read) the installer stops with `receipt signing key: invalid` instead of finishing.
- Those two variables always win over the install-generated key. The base `docker-compose.yml`
  deliberately does not forward them from your shell (a host path from `demo:export-key` would not
  exist in the container); without the installer, set both in your own compose override, with the
  file mounted.
- Receipts already signed stay verifiable: the old key's public half stays recorded and listed at
  `GET /v1/receipts/keys`. To go back, delete the two `REGULAIT_RECEIPT_KEY_HOST_*` lines from
  `.env` and re-run without the flags.
- A hardware-backed (HSM) key is a separate decision (ADR-0183) and not offered here.

**Back it up** with `regulait_pgdata` (see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)). Losing it is
recoverable: the next boot makes a new key under a new key id, and the receipts signed with the old
one still verify against its recorded public key. Read the key-retirement section there: the
product has no way yet to retire the old key id.

### The identity issuer key and the public URL (ADR-0188 S7)

Engine runners and PDP clients (the Kong adapter) no longer hold bearer secrets: each holds its own
Ed25519 key and takes short DPoP-bound tokens from the gateway's `/oauth/token`. Two things must
exist for that:

- **An issuer signing key.** Like the receipt key, the installer and the gateway's first boot create
  one in the install secrets volume as `identity-signing-key.pem` (mode `0600`, owned by the
  gateway's user, never overwritten). The boot log's `issuer key:` line and the installer's
  `Identity issuer key` step name it by key id only. `REGULAIT_IDENTITY_SIGNING_KEY` (a PEM file of
  one or more PKCS#8 Ed25519 keys) always wins; listing the next key beside the current one and
  rotating at **Admin → Workload identities → Issuer signing keys** is how a key is rotated (the old
  public half stays published until the tokens it signed expire). `GET /v1/org/posture` reports
  `identitySigningKey.source` (`install_generated`, `operator_managed`, `missing`, `invalid`).
- **`REGULAIT_PUBLIC_URL`.** It is the issuer every token and proof names. The installer writes
  `https://<domain>` when Caddy terminates TLS and keeps a value you set; behind your own terminator
  it warns and leaves it to you. Runners receive the same value through compose (they still dial
  `http://gateway:3000`).

**Runners** generate their key on first start (`runner-key` on their own state volume, mode `0600`),
register its public half with the one-time enrolment token, and rotate it themselves before it
expires (`POST /v1/engine-runner/credentials`, proved by the current key). An upgrade revokes every
old `rge_` runner token (migration 0195): re-enrol each runner with a new enrolment token. **PDP
clients** are provisioned by an admin: see [GATEWAY_TOPOLOGY.md](GATEWAY_TOPOLOGY.md) §3.

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

**Strict by default (ADR-0181).** Two environment knobs now default to their strict value:

| Variable | Default | Relaxed value |
|---|---|---|
| `REGULAIT_DATABASE_SSL` | `require` (TLS, server certificate verified) | `no-verify` (TLS, self-signed), or `disable` (plaintext; the bundled compose `db` service sets it, the gateway prints a loud boot warning and the enforcement posture reads "database TLS: relaxed") |
| `REGULAIT_SCHEDULER` | on (the sweeps run) | `off` (drive the sweep endpoints from your own cron) |

An unrecognised value of either fails toward the strict side. A fresh install also starts with MCP
admission `enforce`, a 7-day release-age cooldown, private MCP ranges closed, compiled vendor
endpoints adjudicated against the egress allow-list, and backup verification, spend monitoring and
stale-credential alerts on. Each is relaxable by an admin, and every change is audited old → new.

**Metrics and stdio MCP upstreams (ADR-0185).** Both are off unless you set them:

| Variable | Default | Effect |
|---|---|---|
| `REGULAIT_METRICS_LISTEN` | unset (no `/metrics` anywhere) | `host:port` or a port (e.g. `127.0.0.1:9464`): a **separate** listener that serves only `GET /metrics` (Prometheus text). Keep it on a private network. |
| `REGULAIT_METRICS_TOKEN` | unset | Required (at least 32 characters, no whitespace) whenever either metrics variable is on, or the gateway **refuses to start**. Scrapers send it as `Authorization: Bearer <token>`; a wrong or missing token is a 401 `metrics_unauthorized`, counted rather than audited. |
| `REGULAIT_METRICS_ON_MAIN_LISTENER` | off | `1`/`true`/`on` also mounts `GET /metrics` on the public listener, with the same token check. Any other value than on/off refuses boot. |
| `REGULAIT_MCP_STDIO_ALLOWED_DIRS` | unset (stdio upstreams impossible) | Absolute directories, separated by `:`, that a stdio MCP server's command must resolve inside. An admin must also enable `stdio` in the org's MCP upstream transports; both are needed. Relative or missing entries allow nothing. |
| `REGULAIT_MCP_STDIO_MAX_PROCS` | `4` | Most stdio upstream processes this host runs at once (one per request); capped at 64; a request past the cap is refused (`mcp_stdio_busy`), nothing started. |

Metric labels carry no user, project, email, tool name, URL or URI. A stdio child gets only a minimal safe
environment (never `DATABASE_URL` or `REGULAIT_DATA_KEY`), and its command's sha256 is pinned at registration.

Before you register a stdio server:

- **Put no secret in its arguments.** The argument list is stored in the audit log and shown to admins on the
  server's page. Give the program its credentials some other way, such as a file only the gateway's user can read.
- **Only the command file itself is pinned.** If it is a script, the interpreter it names on its `#!` line and
  any modules that interpreter loads are not checked. Keep those where only an administrator can write them.
  Pinning them, and running the child in isolation, is planned (PF-06).
- **Keep the command and its directories writable by their owner only.** The gateway refuses a command file that
  is world- or group-writable (`world_writable`, `group_writable`). It also refuses one in a directory that is
  group- or world-writable, checking every directory from the file's up to the allowed directory
  (`writable_parent`).

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
