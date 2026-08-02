# Backup and restore for a customer-hosted deployment

This is the BYOC/air-gapped operator view. The mechanism, the measurements behind it, and the
honest limits are in [ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md); the exercised
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

---

## What to back up

| item | how | why |
| --- | --- | --- |
| **Postgres** (`regulait_pgdata`) | verified `pg_dump`, below | everything that matters |
| **`<install-dir>/.env`** | copy to your secret store | holds the data key and the DB password |
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
  protects defeats the split. That is your out-of-band job, and it is the highest-value follow-up
  in ADR-0035.
- **Point-in-time recovery.** See above.
- **Payload encryption beyond storage-level encryption.** A dump contains every user record and the
  entire audit log in the clear. Anyone who can read your backup destination can read all of it.
  Encrypt at rest with a key *you* control if that matters.
- **Paging.** ADR-0035's freshness alarm turns red in a console and emails nobody until a human
  subscribes an SNS topic. Wire your own alerting; do not assume silence means success.
