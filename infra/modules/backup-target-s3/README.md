# backup-target-s3

A hardened S3 destination for backups, plus the smallest IAM grant that lets a
machine **write** one and nothing else, plus a CloudWatch alarm that fires when
the machine **stops** writing.

Project-agnostic on purpose: it knows nothing about Postgres, about this repo,
or about what is in the objects. It is "a place backups go, that the thing being
backed up cannot destroy". The job that produces the backup lives elsewhere —
for this project, `infra/scripts/pg-backup.sh`.

## Usage

```hcl
module "db_backup" {
  source = "../../modules/backup-target-s3"

  name        = "my-stack-db"
  bucket_name = "my-stack-db-backup-123456789012"   # S3 names are global
  prefix      = "postgres"

  writer_role_names = [module.app.instance_role_name]

  retention_days         = 30
  enable_freshness_alarm = true
  freshness_missing_days = 3
  alarm_sns_topic_arns   = []   # empty = red in the console, emails nobody

  tags = local.tags
}
```

## The threat model, stated plainly

The machine that writes backups is the internet-facing one. It is, by
construction, the most likely thing in the stack to be compromised. So the
credential it carries is designed on the assumption that an attacker will
eventually hold it.

| The writer can | The writer cannot |
| --- | --- |
| `s3:PutObject` under `<prefix>/*` | `s3:GetObject` — it cannot read back any backup |
| `s3:AbortMultipartUpload` under `<prefix>/*` | `s3:DeleteObject` / `s3:DeleteObjectVersion` |
| `s3:ListBucket`, prefix-conditioned | `s3:PutBucketVersioning` (cannot turn versioning off) |
| `cloudwatch:PutMetricData` in one namespace | `s3:PutLifecycleConfiguration` (cannot shorten retention) |
| | anything outside `<prefix>/` |

Denying `GetObject` costs nothing and buys something real: an attacker with root
on the box already has the *live* database, so read access adds nothing for
them — but the archive of **past** states, including rows that have since been
deleted, stays out of reach.

### Can the writer overwrite an existing backup? Yes. Here is what that means.

`s3:PutObject` on `<prefix>/*` permits writing a key that already exists. S3 has
no "create but do not overwrite" permission, so this is not avoidable through
IAM alone. An attacker with box access can therefore:

- **overwrite yesterday's backup with garbage** — but versioning is on, so the
  overwrite creates a *new* version and demotes the real one to noncurrent, and
  nothing the writer holds can delete a version. Recovery is
  `aws s3api list-object-versions` plus fetching the last good `VersionId`. The
  runbook is written around versions for exactly this reason.
- **spray junk keys to run up the storage bill** — bounded by the lifecycle
  rule, and visible as a bucket that suddenly has thousands of objects.

What they **cannot** do is make the old bytes go away. That is the property that
matters, and it is why versioning here is load-bearing rather than hygiene.

The bucket policy re-states the deletion denials as an explicit `Deny` on the
writer principals. That is deliberate: an identity-policy `Allow` attached
later — by a well-meaning human, or by a stolen admin session — cannot override
an explicit `Deny` in the resource policy.

### What this module does not defend against

- **An account admin.** Anyone who can edit the bucket policy is the trust root
  by construction. Object Lock in compliance mode would blunt even that, at the
  cost of making the lifecycle rule unable to expire anything inside the
  retention window, and of making a fat-fingered 10-year retention permanent.
  Not worth it for a dev stack; revisit if a compliance tag ever demands WORM.
- **`terraform destroy` run by an admin who then answers "yes" twice.**
  `force_destroy = false` makes the destroy *fail* on a non-empty bucket rather
  than quietly emptying it — that is the whole point of the flag — but an
  operator who then empties the bucket by hand gets what they asked for.
- **Reading the objects.** They are encrypted at rest with SSE-S3 by default,
  which protects against a stolen disk in an AWS datacentre and against nothing
  else. Anyone in the account with `s3:GetObject` can read a backup. If the
  payload needs to be secret from account readers, encrypt it before upload.

## Encryption choice

SSE-S3 (`AES256`) by default, because it is free and, for a bucket whose only
readers are this account's own admins, a customer-managed KMS key isolates it
from nobody — while costing $1/month plus per-request charges. Set
`kms_key_arn` when a compliance regime genuinely requires a key whose grants you
control; `bucket_key_enabled` is switched on automatically in that case to
collapse per-object data-key calls.

Note the writer's KMS grant is **encrypt-only** (`GenerateDataKey`, `Encrypt`,
`DescribeKey` — no `Decrypt`), which keeps the "cannot read back its own
backups" property true under KMS as well.

## Retention

Three independent expiries, all enforced by S3 rather than by anything that
could be tricked into running early:

| Rule | Default | What it bounds |
| --- | --- | --- |
| `expiration.days` | `retention_days` = 30 | how far back you can restore |
| `noncurrent_version_expiration` | 7 | the cost of overwrite spam |
| `abort_incomplete_multipart_upload` | 7 | invisible-but-billed part debris |

There is a fourth rule cleaning up expired delete markers, which are invisible
in a plain `ls` and otherwise accumulate forever on a versioned bucket.

## The freshness alarm

The classic backup failure is not a crash. It is a job that silently stops
running and is discovered on the day it is needed. So the signal is inverted:

- the writer publishes `BackupSuccess = 1` on every **verified** upload and `0`
  on any failure,
- the alarm fires when the **Sum over 24h is below 1** for
  `freshness_missing_days` consecutive periods,
- `treat_missing_data = "breaching"` — a metric that stops being published reads
  as failure, not as `INSUFFICIENT_DATA`. Without this the alarm would sit grey
  forever, which is precisely the silence it exists to break.

`freshness_missing_days` defaults to **3**, not 1, because a box on a weekday
power schedule legitimately misses Saturday and Sunday. Stated plainly: **3 days
is also the detection latency.** A backup that breaks on Monday is flagged on
Thursday.

**`alarm_sns_topic_arns` is empty by default, and an empty list means the alarm
turns red in the CloudWatch console and notifies nobody.** That is the honest
posture, not an oversight — a topic created here would still page nobody until a
human confirmed a subscription. The `alarm_notifies_anyone` output exists so a
caller can assert on it rather than assume.
