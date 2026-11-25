<!-- fold: state-decisions -->
**ADR-0360 (builder lane E41, 2026-11-17, Proposed): endpoint fleet operations and EDR.** Self-update is off by default
and a per-device-group relaxation (step-up, audited; D-2026-11-22-04); a rollout's halt threshold is bounded 1 to 10, loosening a step-up; updates are verified against a pinned release keyring with the agent's existing Ed25519
envelope (go-tuf v2 failed admission on unmaintained transitive modules; minio/selfupdate and fynelabs/selfupdate are
unmaintained; creativeprojects/go-selfupdate is forge-bound), staged by device group,
refuse a downgrade and roll back on a failed health check; the device acts only on a directive signed by the
device-policy signer. One-line enrolment is a single-use, at-most-60-minute, source-scoped token read from standard
input. EDR (Defender, Falcon, SentinelOne) is read-only by default; isolation is optional, approved and stepped up.
