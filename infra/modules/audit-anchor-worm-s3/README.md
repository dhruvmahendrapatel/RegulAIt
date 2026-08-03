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

Allowed: `s3:PutObject` under the prefix, and a prefix-limited `s3:ListBucket`
for the on-box self-check.

Explicitly denied — in the **bucket** policy, where a later identity-policy
`Allow` cannot override it:

* `s3:DeleteObject`, `s3:DeleteObjectVersion` — the whole point.
* `s3:PutObjectRetention`, `s3:PutObjectLegalHold`,
  `s3:BypassGovernanceRetention` — it cannot shorten its own retention or bypass
  GOVERNANCE mode. Without this, GOVERNANCE mode is decorative against exactly
  the adversary this exists for.
* `s3:PutBucketObjectLockConfiguration`, `s3:PutBucketVersioning`,
  `s3:PutLifecycleConfiguration` — it cannot weaken the mechanism it writes into.
* `s3:GetObject` — it never needs to read anchors back. The verifier that does
  is a separate, human-initiated act with a separate credential, so a
  compromised gateway host cannot even enumerate the true history.

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

## What is not wired yet

The gateway's anchor **emit path** is implemented and tested
(`apps/gateway/src/audit-chain.ts`), against an `AnchorSink` interface. The
built-in sink today is `LocalWormSink` — the air-gapped buffer, which reports
`tamperResistant: false` because a directory on the same host is not WORM. The
S3 sink that writes into this bucket is a follow-up; shipping a half-configured
S3 writer that silently no-ops would be exactly the false assurance ADR-0060
exists to avoid.
