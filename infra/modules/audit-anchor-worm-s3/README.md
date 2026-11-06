# audit-anchor-worm-s3

WORM destination for **ADR-0060** audit-chain head anchors: an S3 bucket with
Object Lock, plus the smallest IAM grant that lets a machine *add* an anchor and
nothing else.

> **Nothing in this module has been applied to any AWS account.** Creating the
> bucket is a separate, explicitly authorised act. Read the COMPLIANCE-mode
> warning below first — it is irreversible.

## What it is for

`audit_log` rows are hash-chained (migration 0067). That detects any edit by
someone who cannot recompute the whole chain. It does **not** detect a database
administrator who rewrites every row *and* every hash: that forgery is
internally consistent, and local verification passes it. There is a test that
asserts exactly that, because a control whose limits are not written down gets
sold as covering things it does not.

What closes the gap is pinning the chain **head** — `seq` + `row_hash` +
timestamp, a few hundred bytes — somewhere that administrator cannot rewrite.
A full recompute then diverges from the anchored head and
`GET /v1/audit/verify` reports the divergence.

## Why it is not the ADR-0035 backup bucket

Different threat model, and incompatible deletion semantics:

| | `backup-target-s3` | this module |
|---|---|---|
| answers | "we lost the database" | "somebody edited the database" |
| deletion | lifecycle expires objects after `retention_days` | objects **cannot** be deleted before retention lapses, by anyone |

One bucket would mean either backups that cannot be aged out, or anchors that
can be deleted. So: two buckets.

## GOVERNANCE vs COMPLIANCE — read before applying

`object_lock_mode` defaults to **GOVERNANCE**, which stops accidents and casual
insiders but **not** a principal holding `s3:BypassGovernanceRetention`. That is
not the ADR-0060 guarantee.

**COMPLIANCE** is the mode the ADR actually asks for. For the retention period:

* no principal can delete the object version — not an admin, not the account
  **root**, not AWS Support;
* the retention period can only be **extended**, never shortened;
* the only way to stop paying for a mistakenly-written object is to close the
  AWS account.

That is the point, and it is also an unrescindable financial and operational
commitment, which is why a module default does not make it for you.

## What the writer can and cannot do

The grant is sized to the calls the gateway's `S3ObjectLockSink`
(`apps/gateway/src/audit-chain.ts`) actually makes. Before 2026-11-01 it was
`PutObject` only, with `s3:PutObjectRetention` denied in the bucket policy, so a
stack that passed `writer_role_names` had every locked PUT refused and could not
read the lock configuration that grades it (ADR-0060 amendment 2026-11-01).

| Sink call | Permission | Scope |
|---|---|---|
| `PutObject` with `ObjectLockMode` + `ObjectLockRetainUntilDate` | `s3:PutObject`, `s3:PutObjectRetention` | `<bucket>/<prefix>/*` |
| `GetObject` by `VersionId` | `s3:GetObject`, `s3:GetObjectVersion` | `<bucket>/<prefix>/*` |
| `GetObjectRetention` by `VersionId` | `s3:GetObjectRetention` | `<bucket>/<prefix>/*` |
| `ListObjectVersions` | `s3:ListBucketVersions` (+ `s3:ListBucket`) | bucket, `s3:prefix` = `<prefix>/*` |
| `GetObjectLockConfiguration` — **grades tamper resistance** | `s3:GetBucketObjectLockConfiguration` | bucket |
| SSE-KMS, only when `kms_key_arn` is set | `kms:GenerateDataKey`, `kms:Decrypt` | the key, `kms:ViaService` = `s3.<region>.amazonaws.com`, encryption context = this bucket |

Explicitly denied to the writer roles — in the **bucket** policy, where a later
identity-policy `Allow` cannot override it:

* `s3:DeleteObject`, `s3:DeleteObjectVersion` — the whole point.
* `s3:BypassGovernanceRetention`, `s3:PutObjectLegalHold` — it cannot bypass
  GOVERNANCE mode or play with legal holds.
* `s3:PutBucketObjectLockConfiguration`, `s3:PutBucketVersioning`,
  `s3:PutLifecycleConfiguration`, `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy`,
  `s3:DeleteBucket` — it cannot weaken or remove the mechanism it writes into.
* A `PutObject`/`PutObjectRetention` whose **lock mode** is weaker than the
  bucket's (GOVERNANCE on a COMPLIANCE bucket), or whose **remaining retention**
  is shorter than `retention_days − 1`. These match only when the request
  carries the header, so a plain PUT taking the bucket default is unaffected.

### Why `s3:PutObjectRetention` is allowed

The sink cannot write a locked anchor without it. Allowing it does not let the
writer shorten an existing lock:

* **COMPLIANCE** — S3 refuses to shorten or remove a retention, for every
  principal including root. Only extension is possible.
* **GOVERNANCE** — S3 refuses to shorten or remove a retention unless the
  request sends `x-amz-bypass-governance-retention: true` **and** the caller holds
  `s3:BypassGovernanceRetention`, which stays explicitly denied. So the writer
  can only extend, or raise the version to COMPLIANCE.

The one real weakening — a *new* version written with a weaker mode or shorter
date than the bucket default — is what the two conditional denials above close.

**Operator corollary:** set the gateway's `REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS`
to at least `retention_days`. A shorter value is refused by the bucket policy
and every anchor row records `failed` — loudly, by design.

### Why the writer can read

The original design kept reads on a separate verifier credential. The sink as
built verifies on the gateway (it reads back the version it wrote, ADR-0189 R44),
so it needs reads. Anchors are hashes; reading one cannot alter it.

Plus a blanket `Deny` on non-TLS access.

## Retention is a compliance parameter

`retention_days` should **match or exceed** the audit-log retention the
deployment's classification requires (ADR-0060's compliance-cascade note). An
anchor that expires before the rows it pins leaves those rows unprovable — a
failure mode that is worse for being quiet. The `365` default is a starting
point, not a recommendation for a regulated workload.

## BYOC

In the primary motion (ADR-0041) this bucket lives in the **customer's** account
under their IAM, like the ADR-0035 backup target. The customer holds the
immutable anchor, which means even RegulAIt cannot rewrite their evidence. The
module deliberately declares no provider block so the caller supplies the
account.

## Cost

An anchor is a few hundred bytes. Hourly for a decade is roughly 9 MB. There is
deliberately **no lifecycle expiration rule**: on a COMPLIANCE bucket it could
not delete a locked version anyway, and having one would imply anchors age out.

## Status

The gateway's S3 sink (`S3ObjectLockSink`, `apps/gateway/src/audit-chain.ts`)
writes into this bucket when `REGULAIT_AUDIT_ANCHOR_S3_BUCKET` is set; without it
the gateway uses `LocalWormSink`, which reports `tamperResistant: false`. The
grade is read from the bucket (`GetObjectLockConfiguration`), so only a
COMPLIANCE bucket earns "tamper-resistant".

Not applied anywhere. This module has never been `terraform apply`'d by this
repository; the owner applies.
