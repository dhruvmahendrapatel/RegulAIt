# ADR-0324: Release-key ceremony, root-signed keyring and release verification (signature, SBOM, provenance)

- **Status**: Accepted (lane E9 brief, owner decision 2026-11-15: "Prepare the runbook now"; the owner runs the real ceremony later)
- **Date**: 2026-11-15
- **Index**: **Release-key ceremony prepared (PENDING S3): offline 2-of-3 Ed25519 root keys sign a canonical keyring statement that authorises the release signing key, names the one builder workflow and lists revocations; `verify-release.sh` checks root chain, bundle signature, CycloneDX SBOM and SLSA v1 provenance offline; CI builds only unsigned candidates and verifies published releases.** The real ceremony is still owner-gated; the dev key stays until then.
- **Backlog item**: [PENDING.md](../product/PENDING.md) S3 (no real release keypair)
- **Built in**: lane E9, branch `builder/e9-key-ceremony` (one PR)
- **Migration**: none
- **Related**: [ADR-0041](0041-byoc-primary-motion.md) (signed update bundles, pinned keyring), [ADR-0052](0052-licensing-seats.md)
  (licence verifier, its own keyring `infra/license-keys/`), [ADR-0184](0184-own-security-ci.md) (cosign keyless, Trivy SBOMs),
  [ADR-0304](0304-kubernetes-operator-and-helm-chart.md) (operator's compiled keyring), ADR-0176 (open source first),
  ADR-0180 (secure by default)

## Context

ADR-0041 ships signed update bundles verified offline against a pinned keyring (`infra/release-keys/`), which ADR-0304's
operator compiles in. ADR-0052's licence verifier pins its own keyring (`infra/license-keys/`). Each holds one
development key whose private half was never kept (PENDING S3), so nothing can be released or licensed. The keyring is also flat: each `.pub` file is a signer.
Rotating a key takes two releases, a stolen key can be revoked only by delivering a new key out of band, and nothing
ties a release to an SBOM or to the build that made it (ADR-0041's README says provenance is "a further slice").

The threat model is LiteLLM's compromised release of 2026-10-21. `v1.107.0` shipped credential-stealing malware and
remote-code-execution loaders, built and signed by LiteLLM's own pipeline, and LiteLLM rotated its cosign key two
days later (`internal/product/MARKET_ANALYSIS_2026-11.md` §1.2, PR #844). The signature was genuine. Two lessons follow:
a pipeline that holds the signing key signs whatever an attacker gives it, and a signing key needs a way to be revoked
and replaced that a deployment can trust without a network.

## Decision

1. **Two tiers of key.** Three offline **root keys** (Ed25519, independent keys, default threshold **2 of 3**) sign
   only the **keyring statement** `infra/release-keys/keyring.json`. The statement lists the roots and their
   fingerprints, the threshold, the release **signing keys** (fingerprint, purposes `update-bundle`, `provenance`,
   `license` (reserved until the licence verifier reads the statement), and a `notAfter` date), the one **builder** workflow allowed to build releases, and every **revoked**
   key id. It also carries a **serial**. Root keys never sign a release. The tool refuses a threshold of 1 unless
   `--allow-single-root` is passed, and the witness log records that choice (ADR-0180).
2. **One reading only.** The statement and the provenance each have one canonical byte form. The parser re-renders
   what it read and requires byte equality, so a duplicated field, a reordered list or a hand edit is refused. This is
   the same concern as the operator's duplicate-key refusal (ADR-0304).
3. **Trust moves forward only through the roots.** A bundle carries the keyring it was signed under
   (`payload/infra/release-keys/`). The deployment accepts it only if the statement is signed by the threshold of the
   roots **already trusted** (the installed keyring) **and** by the threshold of its own roots, with a serial no lower
   than the installed one. If the serial is the same, the content must be the same. So a stolen signing key cannot add
   a key or a root, an old statement cannot be replayed to un-revoke a key, and a root rotation (new roots endorsed by
   the old quorum) installs in one release. ADR-0041's two-release rotation dance is no longer needed when the roots
   endorse the change. The `.pub` files at the top of the keyring directory must be exactly the statement's signing
   keys, so the flat-keyring verifiers (operator, `verify-update-bundle.sh`) never trust a key the
   roots did not authorise. CI enforces this.
4. **`scripts/verify-release.sh`** is the release verifier (bash, coreutils and openssl only, no network). It checks
   the installed keyring, the bundle's keyring (point 3), and that the signing key is listed with purpose
   `update-bundle`, not revoked, and not expired at the manifest's `createdAt`. It then runs `verify-update-bundle.sh`
   against a one-key keyring, refuses unknown files at the bundle root, requires a CycloneDX SBOM in `payload/sbom/`
   (covered by the manifest), and requires an in-toto v1 / SLSA v1 `provenance.intoto.json`. The provenance's subject
   must be this manifest, its builder the root-named workflow, and its ref `refs/tags/v<version>`, and it must be
   signed by the same release key. `--online` also checks the CI's keyless Sigstore attestation
   (`provenance.sigstore.json`). `--candidate` runs the same checks without signatures, as the signer's pre-sign check.
5. **CI never holds a signing key** (`.github/workflows/release.yml`). On a `v*` tag it builds an **unsigned**
   candidate (`build-update-bundle.sh --unsigned`, which needs `--key-id` and writes `*.unsigned.tar.gz`), a Trivy
   CycloneDX SBOM, and SLSA provenance (`scripts/release-provenance.sh`). It checks that the candidate passes the
   pre-sign check and is **refused** as a release, then uploads it as an artifact. Keyless attestation (cosign
   `attest-blob`, public Rekor) runs only when the owner sets `RELEASE_PROVENANCE_PUBLISH_APPROVED`, the same gating
   as `release-ai-bom.yml`. On `release: published` it downloads the bundles and verifies each one against the default
   branch's keyring. An unsigned or unverifiable asset fails the run. Until the ceremony has run, the candidate job
   fails at its first step, because there is no root-signed keyring and so no key it may name.
6. **A human checks before signing.** The release signer verifies the candidate on a connected machine (`--candidate`,
   `--online` if attested), confirms that the provenance's commit is the reviewed tag, then signs offline with
   `release-ceremony.sh sign-release`. That command repeats the pre-sign check, refuses a key that is not the one the
   candidate names, signs the manifest and the provenance, and verifies the result.
7. **Ceremony tooling and runbook.** `scripts/release-ceremony.sh` provides `keygen` (refuses while a network
   interface is up and refuses to write inside a git checkout; keys AES-256 encrypted by default), `keyring`
   (`--previous` carries revocations forward and requires a higher serial), `sign-keyring` (checks the private key is
   the named root), `sign-release`, `current-signing-key`, `fingerprint` and a hash-chained witness log (`log-verify`).
   A PKCS#11 URI selects a hardware token. `dry-run` performs the whole ceremony with throwaway keys in a temp dir and
   proves 28 cases: verification passes, and tampering, an attacker's own root, a single stolen root, a stolen key
   after revocation, a keyring replay, a missing SBOM, swapped provenance, another workflow's build, an expired key and
   an edited witness log are each refused for the right reason. It then deletes the keys. The scripts test
   (`scripts/release-ceremony.test.mjs`) runs it in CI. The plain-language runbook is
   `docs/ops/RELEASE_KEY_CEREMONY.md`: preparation, rehearsal, ceremony, publication, every release, rotation,
   revocation, the compromise drill, backup and escrow, the hardware token, and a witness sheet.

### Open source first (ADR-0176)

- **TUF** (python-tuf, go-tuf; Apache-2.0) is the standard for threshold roots, monotonic versions and root rotation.
  The customer verifier must run on a bare, air-gapped host with bash and openssl (the ADR-0041 constraint) and keep
  ADR-0041's exact manifest bytes. TUF's timestamp and snapshot roles also assume a freshness channel that an
  air-gapped install does not have. **Exception (rule 4: air-gapped operation, exact-byte format):** the design follows
  TUF's root rules (threshold, old quorum endorses the new root set, version never decreases, explicit revocation)
  without the library. Re-check when the operator (Go) consumes the keyring statement, where go-tuf's verifier could
  replace this logic.
- **minisign** (ISC) has no threshold or delegation model and would add a second key format; openssl is already
  required. **cosign / Sigstore** (Apache-2.0, already pinned in CI) is used for the online keyless attestation.
  **in-toto / SLSA** are formats, not dependencies. **pkcs11-provider** (Apache-2.0) is optional on the signer's
  laptop and is not shipped. No new dependency ships, so `THIRD_PARTY.md` is unchanged.

## Consequences

- The ceremony is ready for the owner to run, and PENDING S3 stays open until it has run. While the keyring is the
  development one, `verify-release.sh` refuses every release and the release workflow fails, which is the correct
  failure direction.
- A stolen signing key is recoverable in-band: two roots revoke it, and every deployment that installs the next
  release refuses it from then on. A deployment that never installs that release still trusts the key. The runbook
  says so and requires an out-of-band customer notice.
- One stolen root alone can do nothing. Two stolen roots need a reinstall out of band, by design.
- Releases now carry an SBOM and signed provenance. Customers can check both offline.

### What is not proven

- The keyless `--online` path and the `attest` job have not run (no OIDC here). They are first proven on the first
  approved tag run.
- The hardware-token (PKCS#11) path has not been run against a physical token.
- The operator (Go) still reads the flat keyring, not the statement. It stays safe because CI requires the flat `.pub`
  set to equal the statement's signing keys, but a customer can still drop a `.pub` into an installed directory.
- The licence signing key (`infra/license-keys/`) is generated at the same ceremony (runbook 4.2) and recorded in the
  witness log, but it is not yet root-authorised: the licence verifier still pins it directly. Follow-ups below.

### Follow-ups (PENDING)

- The operator verifies `keyring.json` (roots, threshold, revocation) instead of the flat `.pub` set, and
  `apply-update-bundle.sh` calls `verify-release.sh`.
- The licence verifier (ADR-0052) accepts a licence key only if a root-signed statement lists it with purpose `license`.
- The owner runs the ceremony (runbook parts 2-5), retires the dev key in the same change and publishes the root
  fingerprints out of band.
