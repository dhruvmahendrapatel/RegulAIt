# Backup and restore for a customer-hosted deployment

This is the BYOC/air-gapped operator view. The mechanism, the measurements behind it, and the
honest limits are in [ADR-0035](../../internal/decisions/0035-nightly-pg-dump-to-s3.md); the exercised
restore procedure for our own dev stack is in [`docs/ops/DB_BACKUP.md`](../ops/DB_BACKUP.md).
This page is what an operator running RegulAIt in *their* environment needs to know.

---

## Read this first: two things fail independently, and they must be stored independently

| what | where it lives | lose it and… |
| --- | --- | --- |
| **the database** | one Docker named volume, `regulait_pgdata` | you lose every user, role, policy, audit row, project, workflow instance and spend record |
| **`REGULAIT_DATA_KEY`** | one line in `<install-dir>/.env`, on the same disk | every credential in any restore is **permanently undecryptable** |

Those two are on the same disk by default. That is the failure mode this page exists to break.

**A restore onto the same box** works completely: same key, ciphertext decrypts, everything comes
back.

**A restore onto a new box without the key** recovers every row and decrypts none of the
credentials. Connector tokens, model API keys and TOTP secrets must all be re-entered by hand.
There is no reset, no support escalation, no vendor-side copy — we do not have your key, which is
the entire point of BYOC.

So: **record `REGULAIT_DATA_KEY` out of band, today.** A password manager, an SSM Parameter Store
`SecureString` under a *different* KMS key, an offline safe. Anywhere whose failure is independent
of this host's disk. Do **not** put it in the same bucket as the backups it protects — that
collapses the envelope split into a single point of failure with extra steps.

The installer prints this warning when it generates a key and refuses to proceed interactively
until you acknowledge it. That is not ceremony.

### The product now checks, and refuses (ADR-0063)

You no longer have to *hope* the key you filed away is the right one.

- The gateway derives a **non-secret fingerprint** of the key — `dk1:` plus 32 hex characters, a
  truncated HMAC that identifies the key and reveals nothing about it — records it in the database
  on first boot, and prints it at every boot:

  ```
  data key:  dk1:3f2a9c11d0be47e5a8c6210fb47d9e02 [verified] — custody attested
  ```

- **Every backup carries that fingerprint**, in the object's S3 metadata (`datakey`) and in
  `manifest.json` (`data_key_fingerprint`). So before you restore anything you can answer *"do I
  have the right key for this dump?"* by comparing two strings, without downloading it.

- **If the running key does not match the recorded one, the gateway refuses to start**, naming both
  fingerprints. That is the restore-onto-a-new-box case, and refusing is deliberate: a gateway that
  boots with the wrong key renders every page and every credential list perfectly and then fails
  every decryption days later — and an admin re-entering credentials in the meantime leaves rows
  under two keys that neither can fully read. The one legitimate mismatch, a deliberate rotation,
  has an explicit override (`REGULAIT_DATA_KEY_ROTATED_FROM=<the old fingerprint>`) that is audited
  with both values — and, when you still hold BOTH keys, a genuine re-encryption walk
  (`REGULAIT_DATA_KEY=<new> REGULAIT_DATA_KEY_OLD=<old> pnpm --filter @regulait/gateway reencrypt`)
  that rewrites every ciphertext row under the new key, resumable after a crash and honest about
  any row it could not read (see the runbook's section III-b). Keep the old key until the walk
  reports completed; destroy it after.

- **Attest custody.** Once the key is filed out of band, record that fact:

  ```bash
  curl -sS "$API/v1/security/data-key/attestations" \
    -H "Authorization: Bearer <admin key>" -H 'Content-Type: application/json' \
    -d '{"method":"password_manager","locationHint":"1Password vault: Platform Ops","confirmRecordedOutOfBand":true}'
  ```

  Or use **Admin → Settings → Data key custody**. Be clear about what this is: it records *your
  claim*, and RegulAIt cannot verify custody — it cannot see inside your password manager. What it
  guarantees is that the **absence** of that claim is impossible to overlook. Until someone
  attests, the boot line says `NO CUSTODY ATTESTATION ON FILE`, the portal shows an alarm, and every
  backup run logs `custody=UNATTESTED` and publishes a `DataKeyAttested` metric of `0` — because an
  unattested backup is a backup that may not be restorable.

---

## What to back up

| item | how | why |
| --- | --- | --- |
| **Postgres** (`regulait_pgdata`) | verified `pg_dump`, below | everything that matters |
| **`<install-dir>/.env`** | copy to your secret store | holds the data key and the DB password |
| **`regulait_install_secrets`** | copy the volume (`receipt-signing-key.pem`, mode 0600) to your secret store | the install-generated receipt signing key (ADR-0189 R25). Losing it is recoverable: the next boot makes a new key under a new key id, and receipts signed with the old one still verify against its recorded public key. An operator-managed key (`--receipt-key-file`) lives wherever you keep it. |
| **Caddy's `regulait_caddy_data`** | optional | the ACME account key and issued certificates. Losing it re-issues, which is cheap but rate-limited (5 duplicate certs/week). Not worth engineering around; worth knowing. |

Nothing else on the box is state. The install directory is configuration, and the application is
an image.

---

## Taking a backup

The minimum, on any deployment:

```sh
docker compose -p regulait exec -T db \
  pg_dump -U regulait -Fc regulait > regulait-$(date -u +%Y%m%dT%H%M%SZ).dump
```

The dump runs **inside the `db` container**, so the client is byte-identical to the server forever
with no version-pinning discipline. `pg_dump` refuses to dump a server newer than itself, and
whatever PostgreSQL your host distro ships is the wrong version to rely on.

### Verify it before you trust it

This is not belt-and-braces; it was measured. On an 8.4 MB `-Fc` dump truncated to 90 %:

| check | result |
| --- | --- |
| `pg_restore --list` | **exit 0** — the table of contents is intact and at the front |
| `pg_restore -f /dev/null` | exit 1, `could not read from input file: end of file` |
| actually restoring it | **0 of 200,000 rows** |

A `--list`-only check would have blessed and stored a file containing none of the data. So:

```sh
pg_restore --list regulait.dump | grep -c 'TABLE DATA'   # must be >= 1
pg_restore -f /dev/null regulait.dump                    # must exit 0 — full decompress
```

### Automating it

`infra/scripts/pg-backup.sh` (ADR-0035) does all of the above plus a size floor, uploads to a
versioned write-only S3 bucket, publishes a CloudWatch success heartbeat, and installs itself as a
**systemd timer** — deliberately not `user_data` and not cron, so it survives a power cycle with no
human step.

It is written for our AWS dev stack, so treat it as a reference implementation rather than a drop-in
for every environment:

- **Air-gapped deployments have no S3.** Point the same verify-then-copy sequence at your own
  offline destination — a mounted NAS path, a tape stager, whatever crosses your boundary. The
  three guards (size floor, `--list`, full `pg_restore -f /dev/null`) are the transferable part.
- **BYOC on AWS** can use `infra/modules/backup-target-s3` directly: versioning on, all four
  public-access blocks on, SSE-S3, a bucket policy denying non-TLS access, `force_destroy = false`,
  and a writer grant of `PutObject` + `AbortMultipartUpload` + prefix-scoped `ListBucket` and
  nothing else. **No `GetObject`, no delete of any kind** — the writer cannot read back or destroy
  its own backups, and the lifecycle rule is the only deletion mechanism in the system.
- **BYOC on Azure/GCP**: the module is AWS-only. The equivalent posture is
  immutable/versioned storage with a write-only principal. Building those modules is not done.

---

## Restoring

### Onto the same box (the ordinary case)

```sh
docker compose -p regulait stop gateway
docker compose -p regulait exec -T db psql -U regulait -d postgres \
  -c 'DROP DATABASE regulait;' -c 'CREATE DATABASE regulait OWNER regulait;'
docker compose -p regulait exec -T db pg_restore -U regulait -d regulait --no-owner < regulait.dump
docker compose -p regulait start gateway     # migrations re-run on boot; they are idempotent
```

Expect 15–30 minutes end to end.

### Onto a new box

1. Install: `./scripts/install.sh --mode <mode> --domain <host> --tls <mode> --data-key "$THE_ORIGINAL_KEY"`.
   **Pass the original key.** This is the step everything else depends on.
2. Restore the dump as above.
3. Verify a stored credential actually decrypts — invoke an agent that uses one, or open a connector
   in the admin console. If it errors, you restored with the wrong key, and no later step will fix
   that.

Several hours, realistically, and **only if you have the key**. Without it, everything else in this
document still works and every credential is still gone.

---

## Rotating the receipt signing key after a lost volume (ADR-0189 R25)

If `regulait_install_secrets` is lost, the next boot generates a new receipt signing key under a
new key id, and the old key's public half stays recorded in `receipt_signing_keys`, so receipts it
signed still verify. Every key's first use is audited (`receipt-signing-key-registered`, with its key
id, fingerprint and source), so the audit log shows when the rotation happened.

**A lost volume is not necessarily a destroyed one.** If the old private key may have been copied (a
backup left somewhere, a host you no longer control), anyone holding it can still sign bytes that
verify under the old key id. Retiring that key id is how a deployment stops trusting it.

**Gap: there is no retire mechanism in the product yet.** The `retired_at` column exists and is
honoured (a retired key can never sign again, and `GET /v1/receipts/keys` shows the date), but no
route, admin action or CLI sets it. Until one exists:

1. Record the old key id and fingerprint from the `receipt-signing-key-registered` audit row (or from
   `GET /v1/receipts/keys`).
2. Tell every verifier to **remove that key from their independently trusted key file**
   (`scripts/verify-receipts.mjs <bundle> <trusted-keys.json>`). Receipts that need it then report
   `unverifiable`, which is the honest answer for a key you no longer trust
   (`packages/shared/src/receipts/README.md`).
3. Do not edit `receipt_signing_keys` by hand. A manual `UPDATE ... SET retired_at` would bypass the
   audit trail and the product's own checks.

`retired_at` is a lifecycle marker, not a revocation attestation: it stops signing and keeps old
receipts verifiable, but it does not prove which bytes were signed before retirement.

## RPO / RTO, honestly

- **RPO**: whatever your schedule is. ADR-0035's reference schedule is one dump per day, so up to
  24 hours of *running* time. There is **no point-in-time recovery**: no WAL archiving, no
  `restore_command`, no base backup. One snapshot per interval is the whole promise.
- **RTO**: 15–30 minutes with the box intact. Several hours if the instance is gone.
- **No automated restore** and no automated restore drill. The procedure above is manual and should
  be rehearsed on a schedule — `pg-backup.sh --verify-restore` restores into a scratch database and
  diffs row counts table by table. It is a thing an operator runs; make it a calendar item.

## What is explicitly not covered

- **The `REGULAIT_DATA_KEY` itself.** Deliberately. Backing the key up alongside the ciphertext it
  protects defeats the split. That is your out-of-band job. ADR-0063 does everything the product
  *can* do around it — fingerprint it, refuse to start under the wrong one, put the fingerprint in
  the backup, and report loudly when nobody has attested custody — but it cannot store the key for
  you, and it does not pretend to.
- **Re-encryption under a new key.** `REGULAIT_DATA_KEY_ROTATED_FROM` re-records the fingerprint;
  it does **not** re-encrypt anything. Ciphertext written under the old key stays unreadable and
  those credentials must be re-entered. A resumable, transactional re-encryption over all twelve
  ciphertext columns is named follow-up scope in ADR-0063, deliberately not half-built.
- **Point-in-time recovery.** See above.
- **Payload encryption beyond storage-level encryption.** A dump contains every user record and the
  entire audit log in the clear. Anyone who can read your backup destination can read all of it.
  Encrypt at rest with a key *you* control if that matters.
- **Paging.** ADR-0035's freshness alarm turns red in a console and emails nobody until a human
  subscribes an SNS topic. Wire your own alerting; do not assume silence means success.
