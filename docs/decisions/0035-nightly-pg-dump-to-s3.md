# ADR-0035: Nightly verified `pg_dump` to a write-only S3 bucket, on a self-installing systemd timer

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

The `regulait-dev-app` stack's **entire database is a Docker named volume
(`pgdata`) on the root EBS volume of one EC2 instance**, `i-013c62adc887c76bb`.
There is no RDS, no replica, no EBS snapshot schedule, and — until this ADR — no
backup of any kind. Every user record, credential ciphertext, audit row,
project, workflow instance and spend record lives there and nowhere else.

That was already the largest unmitigated risk in the stack. Two things sharpened
it this week:

1. **[ADR-0032](0032-scheduled-power-off-dev-infra.md) added a nightly power
   schedule.** The box is now deliberately stopped at 20:00 and started at 08:00
   America/New_York, every weekday. Each cycle is a graceful shutdown that
   preserves EBS — but it is also 250-odd more state transitions per year on the
   one machine holding the only copy.
2. **A `terraform plan` proposed replacing the instance.** The AMI was resolved
   from the SSM "latest Amazon Linux" parameter, AWS re-pointed it, and plan
   started proposing `aws_instance.app must be replaced` with no change on our
   side. Replacement destroys the root volume, and with it the database. It was
   caught and defused (`01be2e4` / PR #84, the AMI is now pinned) **only because
   a human read the plan carefully**.

Pillar 1 sells an audit trail. An audit log with no backup is not an audit log.

Constraints that shaped the design:

- **Terraform is authoritative** ([ADR-0003](0003-terraform-over-cloudformation.md)),
  with reusable modules in `infra/modules/` composed into
  `infra/environments/<name>/`.
- **`user_data` runs once per *instance*, never per boot.** That is the trap
  that froze `REGULAIT_TLS_HOST` and lost swap across a stop/start (ADR-0032).
  Worse, *editing* `user_data` on `aws_instance` makes the EC2 provider stop and
  start the box mid-apply. Any mechanism that lives in `user_data` therefore
  either does not survive a power cycle or cannot be changed without an outage.
- **The backup window is not 24 hours.** A job scheduled at 21:00 on a box that
  powers off at 20:00 never runs at all.
- **`pg_dump` refuses to dump a server newer than itself.** The host has no
  PostgreSQL installed; whatever the distro would ship is the wrong version to
  rely on.
- The dump contains `REGULAIT_DATA_KEY`-encrypted credential ciphertext, but
  also every user record and the entire audit log in the clear.

## Decision

**Take a verified nightly `pg_dump` from inside the `db` container and push it to
a versioned, write-only S3 bucket, driven by a self-installing systemd timer on
the box, with an alarm that fires on the absence of a success heartbeat.**

Five parts.

### 1. Destination: `infra/modules/backup-target-s3` (new, project-agnostic)

Creates the bucket and the smallest IAM grant that can write to it. Versioning
on, all four public-access blocks on, ACLs disabled (`BucketOwnerEnforced`),
SSE-S3 default encryption, a bucket policy denying non-TLS access, and
`force_destroy = false` so `terraform destroy` **fails** on a non-empty backup
bucket rather than quietly emptying it first.

The writer grant is `s3:PutObject` + `s3:AbortMultipartUpload` on
`<bucket>/<prefix>/*`, `s3:ListBucket` conditioned on that prefix, and
`cloudwatch:PutMetricData` conditioned on one namespace. No `s3:*`, no
`Resource: "*"`, **no `s3:GetObject`, and no delete of any kind**. The bucket
policy re-states the deletion denials as an explicit `Deny` on the writer
principal, so a later identity-policy `Allow` cannot re-grant them.

**Overwrite, stated plainly:** `PutObject` on a prefix *does* permit writing a
key that already exists — S3 has no create-only permission. An attacker with box
access can overwrite yesterday's backup with garbage and can spray junk keys to
run up the bill. What they **cannot** do is make the old bytes go away:
versioning is on, an overwrite demotes the real object to a noncurrent version,
and the role holds nothing that can delete a version or turn versioning off.
Recovery from that attack is `list-object-versions` plus the last good
`VersionId`, which is why the runbook is written around versions rather than
keys.

**SSE-S3, not KMS.** Free, and for a bucket whose only readers are this
account's own admins a customer-managed key isolates it from nobody while
costing $1/month plus per-request charges. `kms_key_arn` exists for the day a
compliance tag (pillar 3) demands a key whose grants we control; the writer's
KMS grant in that case is encrypt-only, preserving the "cannot read back its own
backups" property.

**Retention: 30 days** for current versions, 7 for noncurrent, 7 for incomplete
multipart debris, plus expired-delete-marker cleanup. Because nothing holds
`s3:DeleteObject`, the lifecycle rule is the *only* deletion mechanism in the
system — there is no early-delete path to be tricked into running.

### 2. Mechanism: a self-installing systemd timer, not `user_data`, not cron

`infra/scripts/pg-backup.sh` installs itself exactly the way `boot-resync.sh`
does (ADR-0032): copy to `/usr/local/sbin/`, write a `.service` + `.timer`,
`systemctl enable`. The enable symlinks live on the root EBS volume, so **the
timer comes back on every boot with no human step, no `user_data` change, and
therefore no instance stop/start and no new public IP.** Re-running the
installer is how a schedule change is applied; it is idempotent by construction.

Terraform still owns the schedule — `terraform output -raw backup_env_file`
renders `/etc/regulait-pg-backup.env` from the same variables, and
`infra/scripts/install-pg-backup.sh` ships it over SSM. Nothing is retyped by an
operator.

### 3. Timing: `*-*-* 17:00:00 UTC`, `Persistent=true`

**Why 17:00 UTC.** The box runs 08:00–20:00 America/New_York on weekdays.
17:00 UTC is 13:00 local under EDT and 12:00 local under EST — mid-window in
both halves of the year, roughly 4 hours after the box comes up and 7 hours
before it goes down. Neither DST transition can push it outside the window.

**Why the instant is named in UTC rather than in `America/New_York`.** systemd
only gained bare-timezone suffixes on `OnCalendar` in v252; `... UTC` has worked
for a decade. Choosing a UTC instant whose *local* mapping is safe under both
offsets gets DST-proofing without depending on the systemd version of whatever
AMI the box is running.

**Why daily rather than Mon–Fri.** On a weekday-only box the Saturday and Sunday
elapses are simply missed. `Persistent=true` then fires **one** catch-up run
immediately after Monday's 08:00 boot — a free extra restore point at the start
of the week, and a weekly proof that the timer is still alive. It also handles
the manual-start case: a box started at 21:00 on a Tuesday takes a catch-up
backup within a minute or two of boot rather than waiting a day. The service
waits up to 10 minutes for the `db` container to become ready, which is what
makes a boot-time catch-up safe.

### 4. Correctness of the dump: verify before upload, and verify the right thing

The dump runs **inside the `db` container** (`docker exec`), so the client is
byte-identical to the server forever with no version-pinning discipline. The
password is read from the container's own environment by a shell *inside* the
container, so it never appears in this script's argv, its environment, the host
process table, or the log. **There is deliberately no `DATABASE_URL` anywhere in
the script.**

Three guards run before a single byte reaches S3:

1. a minimum size,
2. `pg_restore --list` parses and names ≥ 1 `TABLE DATA` member,
3. **`pg_restore -f /dev/null` fully decompresses every data member.**

Guard 3 is not belt-and-braces, and this was **measured rather than assumed**.
On an 8.4 MB `-Fc` dump of a 200,000-row table truncated to 90%:

| check | result |
| --- | --- |
| `pg_restore --list` | **exit 0** — the TOC is intact and at the front |
| `pg_restore -f /dev/null` | exit 1, `could not read from input file: end of file` |
| actually restoring it | **0 of 200,000 rows**, exit 1 |

A `--list`-only check would have blessed and uploaded a file containing none of
the data. That is precisely the failure mode this ADR exists to prevent, and it
is why the expensive full parse is not optional.

### 5. Failure visibility: a heartbeat, and an alarm on its absence

The writer publishes `RegulAIt/Backup / BackupSuccess = 1` on a verified upload
and `0` on any failure. A CloudWatch alarm fires when the 24-hour Sum is below 1
for **3 consecutive days**, with `treat_missing_data = "breaching"` so a job
that stops publishing entirely reads as failure rather than sitting grey in
`INSUFFICIENT_DATA` forever. 3 days, not 1, because a weekend legitimately
misses two.

Locally the job also fails the systemd unit (non-zero exit), writes
`/var/lib/regulait/pg-backup.status`, and emits a fixed-shape
`RESULT=OK|FAIL reason=…` line the runbook greps for. `pg-backup.sh --check`
prints all of it in one screen.

**Honest limitation, stated rather than papered over: with no SNS topic wired,
the alarm turns red in the CloudWatch console and emails nobody.**
`backup_alarm_sns_topic_arns` defaults to `[]` and the stack exposes a
`backup_alarm_notifies_anyone` output that currently reads `false`. A topic
created here would still page nobody until a human confirmed a subscription, so
the module refuses to imply coverage it does not have. Until someone subscribes,
the real monitoring is "an operator runs `--check`, or looks at the console" —
and the detection latency is up to 3 days plus however long that takes.

## Consequences

### RPO and RTO actually offered

**RPO — up to 24 hours of *running* time.** One backup per day at 12:00–13:00
local. Anything written after that day's run and lost before the next is gone.
Note the useful nuance: while the box is *stopped* nothing is being written
either, so the exposure is bounded by 24 h of uptime, not 24 h of wall clock. A
long weekend is still one restore point, not three days of loss — but the
Monday-morning catch-up run adds one anyway.

**RTO — 15–30 minutes with the box intact.** Download, `pg_restore` into a
scratch database, verify, swap. That path is fully written out in
`docs/ops/DB_BACKUP.md` and has been exercised end to end.

**RTO — several hours if the instance itself is gone**, and with a caveat that
matters more than the clock: `terraform apply`, upload the source bundle, wait
for boot, restore. **The restored credentials will not decrypt.**

### The `REGULAIT_DATA_KEY` dependency — the sharpest edge in this ADR

Connector tokens, model API keys and TOTP secrets are stored as ciphertext under
`REGULAIT_DATA_KEY`. That key is generated by `user-data.sh.tftpl` with
`openssl rand -hex 32` **once per instance**, and written to exactly one place:
`/opt/app/docker-compose.override.yml` on the box's root EBS volume — *the same
single point of failure as the database itself*.

Consequences, plainly:

- A restore **onto the same box** works completely: same key, ciphertext
  decrypts, everything comes back.
- A restore **onto a new instance** recovers every row — users, audit log,
  projects, spend — but every credential ciphertext is permanently
  undecryptable. Those credentials must be re-entered by hand.
- The backup is therefore **useless for credentials without the key**, and this
  ADR does **not** back the key up. Deliberately: putting the key in the same
  bucket as the ciphertext it protects defeats the envelope split entirely.

The correct fix is to record `REGULAIT_DATA_KEY` out-of-band — an SSM Parameter
Store `SecureString` under a different KMS key, or a password manager — so that
key custody and data custody fail independently. **That is not done yet.** It is
the single highest-value follow-up from this ADR, and the runbook says so at the
top of the restore procedure rather than at the bottom.

### What is NOT covered

- **The `REGULAIT_DATA_KEY` itself** — see above.
- **Point-in-time recovery.** No WAL archiving, no `pg_basebackup`, no
  `restore_command`. One snapshot a day, and that is the whole promise.
- **Anything outside Postgres.** The `caddy_data` volume (ACME account key and
  issued certificates) is not backed up; losing it means a fresh Let's Encrypt
  issuance, which is cheap but rate-limited (ADR-0029). The source bundle is
  already in its own S3 bucket. Nothing else on the root volume is state.
- **The instance itself.** No AMI snapshot, no EBS snapshot schedule. Rebuilding
  the box is `terraform apply` plus a bundle upload; this ADR does not shorten
  that.
- **Automated restore.** The restore is a documented, exercised, manual
  procedure. There is no one-button recovery and no automated restore drill in
  CI.
- **Paging.** See the honest limitation above.
- **Encryption of the payload beyond SSE-S3.** Anyone in the account with
  `s3:GetObject` can read a backup, and a backup contains every user record and
  the entire audit log. SSE-S3 defends against a stolen disk in an AWS
  datacentre and against nothing else.
- **An account admin.** Anyone who can edit the bucket policy is the trust root
  by construction. Object Lock would blunt even that, at the cost of making the
  lifecycle rule unable to expire anything and making a fat-fingered retention
  permanent. Not worth it for a dev stack.

### Cost

Negligible. The dump is ~350 KB today; 30 days of daily backups is ~10 MB, well
under $0.01/month of S3 Standard. The CloudWatch custom metric is $0.30/month
and the alarm $0.10/month, both of which sit inside the free tier for now.
EventBridge is not involved. Nothing here meaningfully changes ADR-0032's
≈$10.67/month figure.

### `aws_instance` is untouched, on purpose

Nothing in this change edits `user_data`, the AMI, the instance type, the
security group, the instance profile or the tags. The only edit inside
`infra/modules/app-instance/` is two new **outputs**
(`instance_role_name`, `instance_role_arn`); `user-data.sh.tftpl` is byte-
identical (md5 `72e8424c7e1902dea31a19dd9bcd79eb` on both revisions). The IAM
grant lands as a policy *attachment to the existing role*, which is not an
instance change and cannot trigger a replacement or a stop/start.

This is the same discipline ADR-0032 applied for the same reason: on the EC2
provider a `user_data` change is applied by stopping and starting the box, which
changes its public IP and therefore its hostname and certificate.

### Follow-ups this creates

1. **Record `REGULAIT_DATA_KEY` out-of-band.** Highest value; see above.
2. **Wire an SNS topic with a confirmed subscription** so the freshness alarm
   pages a human instead of a console.
3. **Schedule the restore rehearsal.** `pg-backup.sh --verify-restore` restores
   into a scratch database and diffs row counts table by table. It is currently
   a thing an operator runs; it should become a monthly calendar item, and
   eventually should feed pillar 3's backup ledger
   ([ADR-0017](0017-infra-ops-automation-ledgers.md), and the OFF-by-default
   scheduled backup verification in [ADR-0027](0027-backend-orphans.md)) rather
   than living only in a runbook.
4. **Consider WAL archiving** if the RPO ever needs to be better than a day.
   That is a materially bigger change (an always-on archive target, a
   `restore_command`, and a real base backup) and is not justified for a dev
   stack.
