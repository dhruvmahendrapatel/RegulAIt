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
> ciphertext it protects would defeat the point. Recording it out-of-band is a
> known open follow-up ([ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md)).

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
6. If you did **not** rescue the key: everything restores except credentials.
   Re-enter every connector token, model API key and TOTP enrolment by hand.

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
rehearsal: scratch database dropped
RESULT=OK reason=rehearsal-70-tables-matched
```

Any `DIFF` line, or `RESULT=FAIL`, means the backup you are relying on is not
good. Treat it as an incident.

---

## Reference

- [ADR-0035](../decisions/0035-nightly-pg-dump-to-s3.md) — why this shape, what
  is not covered, the `REGULAIT_DATA_KEY` dependency
- [ADR-0032](../decisions/0032-scheduled-power-off-dev-infra.md) → [POWER_SCHEDULE.md](POWER_SCHEDULE.md)
  — the power window the schedule has to fit inside
- `infra/modules/backup-target-s3/README.md` — the bucket/IAM threat model
- `infra/scripts/pg-backup.sh` — the job itself; every non-obvious choice is
  commented in place
