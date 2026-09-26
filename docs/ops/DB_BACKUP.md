# Database backup and restore — runbook

**Written to be followed by someone who did not build it, at 3am.** Commands are
copy-paste. Read the box at the top before you type anything.

> ### READ THIS FIRST — the one thing that will surprise you
>
> A restore brings back **every row**: users, projects, the whole audit log,
> spend records. It does **not** bring back working **credentials**.
>
> Connector tokens, model API keys and TOTP secrets are stored encrypted under
> `REGULAIT_DATA_KEY`. That key is generated once per **instance** and lives in
> exactly one file, on the box:
>
> ```
> /opt/app/docker-compose.override.yml     (line: REGULAIT_DATA_KEY: …)
> ```
>
> - Restoring **onto the same box** → same key → everything decrypts. Fine.
> - Restoring **onto a new box** → new key → every credential ciphertext is
>   permanently unreadable. The rows are there; the secrets inside them are not.
>   They must be re-entered by hand.
>
> **If the box still exists and you are about to rebuild it, copy that key
> somewhere safe BEFORE you do anything else:**
>
> ```bash
> aws ssm start-session --target i-013c62adc887c76bb --region us-east-1 --profile regulait-admin
> sudo grep REGULAIT_DATA_KEY /opt/app/docker-compose.override.yml
> ```
>
> The key is deliberately **not** in the backup bucket — storing it beside the
> ciphertext it protects would defeat the point
> ([ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md)).
>
> ### Since ADR-0063 you no longer have to guess whether you have the right key
>
> Every backup now carries a **non-secret fingerprint** of the key its ciphertext
> was written under — `dk1:` followed by 32 hex characters. It is a truncated
> HMAC, so it identifies the key and reveals nothing about it.
>
> **Check it BEFORE you restore, not after.** Without downloading the dump:
>
> ```bash
> aws s3api head-object --bucket <bucket> \
>   --key postgres/<host>/<stamp>/regulait-<stamp>.dump \
>   --region us-east-1 --query Metadata
> # -> { "datakey": "dk1:3f2a…", "datakeycustody": "attested", "sha256": "…" }
> ```
>
> or from the sidecar: `manifest.json` → `data_key_fingerprint`.
>
> Compare that to the key you are about to configure. The gateway prints the
> same string at boot (`data key: dk1:…`) and serves it at
> `GET /v1/security/data-key`, and the admin portal renders it under
> **Settings → Data key custody**.
>
> **If they differ, the gateway will refuse to start.** That is deliberate — see
> [ADR-0063](../decisions/0063-data-key-custody.md). A gateway that boots with
> the wrong key looks completely healthy and then fails every decryption days
> later, by which time the old box is usually gone.

---

## What exists

| | |
| --- | --- |
| **What is backed up** | the whole `regulait` Postgres database, `pg_dump -Fc` |
| **How often** | daily, `17:00 UTC` (= 13:00 EDT / 12:00 EST), mid-way through the box's 08:00–20:00 power window ([ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md)) |
| **Plus** | one catch-up run shortly after Monday's boot, for the weekend's missed elapse |
| **Where** | `terraform output -raw backup_destination` → `s3://regulait-dev-app-db-backup-<acct>/postgres/<host>/<stamp>/` |
| **Kept for** | 30 days (`terraform output -raw backup_retention`) |
| **Also kept** | the newest 3 dumps on the box, in `/var/backups/regulait/` |
| **RPO** | up to 24 h of *running* time |
| **RTO** | 15–30 min if the box is intact; hours if it is not |
| **Log** | `/var/log/regulait-pg-backup.log` on the box |
| **Status file** | `/var/lib/regulait/pg-backup.status` |
| **Alarm** | `regulait-dev-app-db-backup-stale` — fires after **3 days** with no success |

All `aws` commands below want `--region us-east-1 --profile regulait-admin`.
If the CLI says the SSO session expired: `aws sso login --profile regulait-admin`.

> **Note on the alarm.** It currently notifies **nobody** — it turns red in the
> CloudWatch console and that is all. Check
> `terraform output backup_alarm_notifies_anyone`; while that is `false`, the
> real monitoring is a human running `--check` (below). Detection latency is up
> to 3 days.

---

## I. "Is the backup actually working?" — 30 seconds

From your laptop:

```bash
cd infra/environments/regulait-dev-app
aws s3 ls "$(terraform output -raw backup_destination)" --recursive \
  --region us-east-1 --profile regulait-admin | tail -5
```

You want an object from **today** (or the last weekday the box was up). If the
newest object is older than that, go to section V.

From the box (one command, prints everything):

```bash
aws ssm send-command --region us-east-1 --profile regulait-admin \
  --instance-ids i-013c62adc887c76bb --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/sbin/regulait-pg-backup.sh --check"]' \
  --query 'Command.CommandId' --output text
# then, with the id it printed:
aws ssm get-command-invocation --region us-east-1 --profile regulait-admin \
  --command-id <ID> --instance-id i-013c62adc887c76bb \
  --query StandardOutputContent --output text
```

That prints the timer state, the last service run, the last `RESULT=` lines and
the newest objects in the bucket.

---

## II. Restore — the box is alive, the data is wrong

**Never restore over the live database.** Restore into a scratch database first,
look at it, and only then swap. Every command below does that.

Open a session:

```bash
aws ssm start-session --target i-013c62adc887c76bb --region us-east-1 --profile regulait-admin
sudo -i
```

### 1. Pick the dump

Newest local one (fastest — no download):

```bash
ls -lt /var/backups/regulait/*.dump | head
DUMP=$(ls -1t /var/backups/regulait/*.dump | head -1); echo "$DUMP"
```

Or an older one from S3 (the box's role can list but **cannot** download —
do this bit from your laptop and push the file, or use an admin session):

```bash
# on your laptop
aws s3 ls s3://<bucket>/postgres/ --recursive --region us-east-1 --profile regulait-admin
aws s3 cp s3://<bucket>/postgres/<host>/<stamp>/regulait-<stamp>.dump . \
  --region us-east-1 --profile regulait-admin
```

Each dump has a `manifest.json` beside it with the **exact row count of every
table at dump time**. That is what you check the restore against.

### 2. Restore into a SCRATCH database and check it

The script does the whole thing — restore, compare every table against the
manifest, drop the scratch database:

```bash
/usr/local/sbin/regulait-pg-backup.sh --verify-restore "$DUMP"
```

Read the output. Every line should say `OK`. A `DIFF` line names the table and
both counts. If anything says `DIFF`, **stop** and pick an older dump.

### 3. Only now, swap it in

```bash
cd /opt/app
CID=$(docker compose ps -q db)

# Stop the app so nothing writes while you swap. Leave the db running.
docker compose stop gateway

# Rename the live database out of the way — do NOT drop it. If the restore
# turns out worse than what you have, this is your undo.
docker exec -i "$CID" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U "$POSTGRES_USER" -h 127.0.0.1 -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'regulait'"'"' AND pid <> pg_backend_pid()" \
  -c "ALTER DATABASE regulait RENAME TO regulait_before_restore"'

docker exec -i "$CID" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" createdb -U "$POSTGRES_USER" -h 127.0.0.1 regulait'

docker exec -i "$CID" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" -h 127.0.0.1 \
  -d regulait --no-owner --no-privileges --exit-on-error' < "$DUMP"
echo "pg_restore exit = $?"      # must be 0

docker compose start gateway
```

### 4. Confirm, then clean up

```bash
curl -sS -o /dev/null -w '%{http_code}\n' localhost:3000/healthz      # expect 200
docker exec -i "$CID" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -qtAX -U "$POSTGRES_USER" -h 127.0.0.1 -d regulait \
  -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM audit_log) AS audit"'
```

Leave `regulait_before_restore` in place for at least a day. When you are sure:

```bash
docker exec -i "$CID" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" dropdb -U "$POSTGRES_USER" -h 127.0.0.1 regulait_before_restore'
```

---

## III. Restore onto a NEW box

1. **Read the box at the top of this file.** If the old box is reachable at all,
   get `REGULAIT_DATA_KEY` off it first. Without it, credentials are gone.
   Check which key you need first — it takes one command and costs nothing:
   ```bash
   aws s3api head-object --bucket <bucket> --key <the dump key> \
     --region us-east-1 --query 'Metadata.datakey'
   ```
2. Rebuild: `terraform apply` in `infra/environments/regulait-dev-app`, upload
   the source bundle, wait for `docker compose up` to finish (watch
   `/var/log/app-boot.log`).
3. If you rescued the old key, put it back **before** restoring, so the
   ciphertext in the dump matches:
   ```bash
   sudo sed -i 's|REGULAIT_DATA_KEY:.*|REGULAIT_DATA_KEY: <the old key>|' \
     /opt/app/docker-compose.override.yml
   cd /opt/app && docker compose up -d
   ```
4. Copy the dump onto the box and follow section II from step 2.
5. Re-install the backup timer (section VI) — a new instance has no timer.
6. **Bring the gateway up and read its `data key:` boot line.** If you put back
   the wrong key, it will not start — it prints both fingerprints and stops.
   That is the intended behaviour, not a bug: fix the key and start again.
7. If you did **not** rescue the key: everything restores except credentials.
   The gateway will refuse to start against the restored database, because the
   new key does not match the recorded fingerprint. Declare that deliberately —
   this is a key rotation with no re-encryption, and it is a decision, not a
   default:
   ```bash
   # the fingerprint the refusal names as `recorded`
   REGULAIT_DATA_KEY_ROTATED_FROM=dk1:<the old fingerprint>
   ```
   Put that in `/opt/app/.env` (or the compose override) alongside the NEW
   `REGULAIT_DATA_KEY`, start the gateway once, then **remove it** — it has been
   consumed and the acceptance is in the audit log with both fingerprints.
   Every connector token, model API key and TOTP enrolment must then be
   re-entered by hand. Nothing re-encrypts the old ciphertext; it is dead.
   (If you still HOLD the old key and simply want to move to a new one, do
   not use this path at all — run the re-encryption walk in section III-b,
   which rewrites every row and loses nothing.)
8. **Attest the new key** so this deployment does not repeat the exercise:
   ```bash
   curl -sS "$API/v1/security/data-key/attestations" \
     -H "Authorization: Bearer <admin key>" -H 'Content-Type: application/json' \
     -d '{"method":"password_manager","locationHint":"1Password vault: Platform Ops","confirmRecordedOutOfBand":true}'
   ```

---

## III-b. Rotate the data key WITH re-encryption (you hold both keys)

This is the deliberate-rotation path (ADR-0063 §4's follow-up, batch B4): every ciphertext row
is genuinely rewritten under the new key. Use it when the old key is compromised, leaving with
an operator, or aging out — NOT for the lost-key case (that is §III step 7, and it costs you
the ciphertext).

1. **Generate the new key and record it out of band FIRST** (same custody rules as install —
   the walk must never be the only place the new key exists).
2. **Run the walk** on the box, as a CLI — deliberately not over HTTP, where a proxy timeout
   mid-walk and a retry racing the first attempt are both live risks:
   ```bash
   REGULAIT_DATA_KEY=<the NEW key> REGULAIT_DATA_KEY_OLD=<the OLD key — full 64 hex, not the fingerprint> \
     pnpm --filter @regulait/gateway reencrypt
   ```
   It refuses without both keys, refuses if any `*_ciphertext` column exists that its work
   list does not name (fail closed), and exits 0 saying "nothing to do" if a previous walk
   already finished. Batches are transactional with a per-table watermark, so a crash or
   ctrl-C is safe: **re-run the same command and it resumes exactly where it stopped** — no
   row processed twice, none missed. Watch progress from another terminal via
   `GET /v1/security/data-key/reencryption` (admin).
3. **Read the exit honestly.** Exit 0 = every row is under the new key. Exit 2 =
   `completed_with_failures`: some rows decrypted under NEITHER key — they are listed in the
   output and in the run's failure record (table + id), everything else was rotated. Those
   rows were already unreadable; re-enter those specific credentials by hand.
4. **Switch the gateway to the new key**: set `REGULAIT_DATA_KEY` to the new key, remove
   `REGULAIT_DATA_KEY_OLD`, restart. No `REGULAIT_DATA_KEY_ROTATED_FROM` declaration is
   needed — the walk already re-recorded the fingerprint, so the boot is an ordinary
   `verified`.
5. **Only after the walk reports completed: destroy the old key** everywhere it was recorded
   (password manager entry, escrow copy). Destroying it earlier turns every not-yet-walked
   row into a failure. Then **attest the new key** (step 8 above).

---

## IV. Someone overwrote or corrupted a backup object

The instance role cannot **delete** anything, and the bucket has versioning on,
so the previous bytes still exist as a noncurrent version.

```bash
aws s3api list-object-versions --bucket <bucket> --prefix postgres/ \
  --region us-east-1 --profile regulait-admin \
  --query 'Versions[].{Key:Key,VersionId:VersionId,Modified:LastModified,Size:Size}' --output table

aws s3api get-object --bucket <bucket> --key <key> --version-id <good-version-id> \
  recovered.dump --region us-east-1 --profile regulait-admin
```

Then verify it before trusting it:

```bash
pg_restore --list recovered.dump | grep -c 'TABLE DATA'   # must be > 0
pg_restore -f /dev/null recovered.dump; echo "exit=$?"    # must be 0
```

---

## V. The backup has stopped running

Symptoms: no new objects; the `…-backup-stale` alarm is red; `--check` shows an
old `RESULT=`.

Work down this list on the box (`sudo -i`):

```bash
systemctl status regulait-pg-backup.timer      # active? enabled?
systemctl list-timers regulait-pg-backup.timer --all --no-pager
systemctl status regulait-pg-backup.service    # last run's exit
tail -60 /var/log/regulait-pg-backup.log
cat /var/lib/regulait/pg-backup.status
```

`RESULT=FAIL reason=…` tells you which guard tripped:

| `reason=` | What it means | What to do |
| --- | --- | --- |
| `no-bucket-configured` | `/etc/regulait-pg-backup.env` missing or empty | re-run the installer (section VI) |
| `db-unavailable-after-600s` | the `db` container never became ready | `docker compose ps`; `docker compose logs db` |
| `pg_dump-exit-N` | the dump itself failed | read the log; usually disk or a dead container |
| `dump-too-small-…` | the dump is implausibly small | check `df -h`; the disk is probably full |
| `toc-unreadable` / `toc-has-no-table-data` | the archive header is broken | disk, or a killed `pg_dump` |
| `archive-truncated-or-corrupt` | **the dump was cut short** — the guard did its job and refused to upload a bad backup | `df -h`, then re-run |
| `s3-upload-failed` | credentials, network, or the bucket | check the instance role and the bucket name in the env file |

Force a run and watch it:

```bash
/usr/local/sbin/regulait-pg-backup.sh --run
```

If the timer is simply **not installed** (a rebuilt box, most likely), go to
section VI.

---

## VI. Install or re-install the timer

Idempotent. This is also how you apply a schedule or retention change: change
the Terraform variable, `terraform apply`, then run this.

From the repo root, with the SSO profile active:

```bash
cd infra/environments/regulait-dev-app && terraform apply    # if you changed anything
cd ../../..
bash infra/scripts/install-pg-backup.sh
```

It reads bucket / prefix / schedule from Terraform outputs, uploads
`infra/scripts/pg-backup.sh` to the stack's source bucket, and sends one SSM
command that writes `/etc/regulait-pg-backup.env` and runs `--install`.

Verify:

```bash
aws ssm send-command --region us-east-1 --profile regulait-admin \
  --instance-ids i-013c62adc887c76bb --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl list-timers regulait-pg-backup.timer --all --no-pager","/usr/local/sbin/regulait-pg-backup.sh --run"]'
```

**Turning it off:** set `backup_enabled = false`, `terraform apply`, re-run the
installer — the timer is disabled, and the bucket, its contents and the IAM
grant are untouched. Or, on the box, `pg-backup.sh --uninstall`.

---

## VII. Rehearse the restore (do this monthly)

The only check that proves the backup is *restorable* rather than merely
*well-formed*. It restores into a throwaway database, compares every table's row
count against the manifest, and drops it again. It never touches the live
database.

```bash
aws ssm send-command --region us-east-1 --profile regulait-admin \
  --instance-ids i-013c62adc887c76bb --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/sbin/regulait-pg-backup.sh --verify-restore"]' \
  --query 'Command.CommandId' --output text
```

Expected tail:

```
rehearsal: pg_restore completed clean
rehearsal: table | source rows | restored rows
  OK   audit_log | 87 | 87
  …
rehearsal: the restored copy needs data key dk1:3f2a… (custody: attested)
rehearsal: scratch database dropped
RESULT=OK reason=rehearsal-70-tables-matched datakey=dk1:3f2a… custody=attested
```

Any `DIFF` line, or `RESULT=FAIL`, means the backup you are relying on is not
good. Treat it as an incident.

`custody=UNATTESTED` is a **separate** incident of its own, and the job says so
loudly in its log, in `manifest.json`, in the status file and as a
`Backup/DataKeyAttested` CloudWatch datapoint of `0`. It means the dump is
verified and may still be **unrestorable**, because nobody has recorded the key
that decrypts its credentials anywhere but on this box. Fix it in one call:

```bash
curl -sS "$API/v1/security/data-key" -H "Authorization: Bearer <admin key>"   # read the fingerprint
# record it out of band, THEN:
curl -sS "$API/v1/security/data-key/attestations" \
  -H "Authorization: Bearer <admin key>" -H 'Content-Type: application/json' \
  -d '{"method":"password_manager","locationHint":"1Password vault: Platform Ops","confirmRecordedOutOfBand":true}'
```

`sudo bash pg-backup.sh --check` prints the live custody state at any time.

---

## Reference

- [ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md) — why this shape, what
  is not covered, the `REGULAIT_DATA_KEY` dependency
- [ADR-0063](../decisions/0063-data-key-custody.md) — the key fingerprint, why a
  mismatched key REFUSES to start rather than booting, the custody attestation
  and its honest limits, and why full re-encryption is named follow-up scope
  rather than half-built
- [ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md) → [POWER_SCHEDULE.md](POWER_SCHEDULE.md)
  — the power window the schedule has to fit inside
- `infra/modules/backup-target-s3/README.md` — the bucket/IAM threat model
- `infra/scripts/pg-backup.sh` — the job itself; every non-obvious choice is
  commented in place
