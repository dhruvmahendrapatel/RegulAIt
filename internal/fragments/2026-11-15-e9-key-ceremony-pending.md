<!-- fold: pending -->

**S3 follow-ups (ADR-0324, 2026-11-15, lane E9).** (1) The operator (ADR-0304) verifies `keyring.json` (roots,
threshold, revocations) instead of trusting every `.pub` in the directory (`apply-update-bundle.sh` already calls
`verify-release.sh`, #853 review). (1a) `--online` compares the attested predicate with the local provenance, and an
`--expect-root-fingerprint` option pins the roots on first install (#853 review C8, C3). (1b) The licence
verifier (ADR-0052, `infra/license-keys/`) accepts a licence key only if the root-signed statement lists it with
purpose `license`; the ceremony makes the licence key (runbook 4.2b) but it is pinned directly until then. (2) First proof of the keyless `attest` job and `--online` on the first owner-approved tag
(`RELEASE_PROVENANCE_PUBLISH_APPROVED`). (3) Run the hardware-token (PKCS#11) path once against a real token before
relying on it. (4) Owner: run the ceremony (runbook parts 2-5) and publish the root fingerprints out of band.
