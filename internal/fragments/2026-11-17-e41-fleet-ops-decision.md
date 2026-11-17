<!-- fold: state-decisions -->
**ADR-0360 (builder lane E41, 2026-11-17, Proposed): endpoint fleet operations and EDR.** Self-update is off by default
and a per-source relaxation (step-up, audited); updates are TUF-verified (go-tuf v2 chosen over minio/selfupdate and
fynelabs/selfupdate, both unmaintained, and creativeprojects/go-selfupdate, forge-bound), staged by device group,
refuse a downgrade and roll back on a failed health check; the device acts only on a directive signed by the
device-policy signer. One-line enrolment is a single-use, at-most-60-minute, source-scoped token read from standard
input. EDR (Defender, Falcon, SentinelOne) is read-only by default; isolation is optional, approved and stepped up.
