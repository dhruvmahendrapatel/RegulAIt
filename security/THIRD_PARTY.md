# Third-party tools in our own security CI (ADR-0184)

These run only in `.github/workflows/security.yml`, unmodified, against our own code and image. None is a dependency of
the product, none is copied into the image, and none runs in a customer install, so ADR-0176's licence rule for shipped
code does not apply; the licences are recorded anyway. Pins are in `security.yml` (versions, SHA-256, commit SHAs) and
the bump procedure is in `docs/ops/SECURITY_CI.md`.

| Tool | Version | Licence | Why |
|---|---|---|---|
| CodeQL CLI and its bundled query packs (via `github/codeql-action`) | CLI 2.27.3 (bundle `codeql-bundle-v2.27.3`, pinned via the init step's `tools:` URL), action v4.39.0 | CLI: GitHub CodeQL Terms (free for public repositories and research; not open source). Queries and the action: MIT | SAST for JavaScript/TypeScript and for the workflows. Chosen over Semgrep OSS because the repository is public, so CodeQL is available without GitHub Advanced Security, and the same job uploads the Security tab's alerts (default setup is off, ADR-0184 As built 2026-10-22), so the gate and the alerts agree. Semgrep OSS (LGPL-2.1 engine, rules under their own licences) is the recorded fallback if the repository goes private. |
| gitleaks | 8.30.1 | MIT | Secret scanning over the diff and the full git history. |
| Trivy | 0.74.0 | Apache-2.0 | Container image vulnerability scan and CycloneDX SBOMs of the workspace and the image. Its vulnerability database is downloaded at run time (data from the upstream advisory sources under their own terms). |
| cosign (Sigstore) | 3.1.3 | Apache-2.0 | Verifies Trivy's release signature; keyless signing and verification of our image. Uses the public Fulcio and Rekor instances. |
| registry (CNCF Distribution) | 3 (pinned by digest) | Apache-2.0 | A throwaway local registry inside the job, so cosign can sign and verify without publishing anything. |
| `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact` | v6.0.3, v6.5.0, v7.0.1, v8.0.1 (pinned by commit) | MIT | Standard GitHub Actions plumbing. |

## Engine image signing and verification (ADR-0197 Q2)

The engine image publish (`.github/workflows/engine-images.yml`) signs each pushed digest keylessly, and the lock
tooling, `scripts/build-image-bundle.sh --with-engines` and the air-gapped `scripts/install.sh` verify the signature
before an engine image is recorded, bundled or run (`scripts/engine-images-lock-verify.mjs`). Nothing here is copied
into an image or the product. On an operator's host the installer runs the operator's own copy of cosign, which it
refuses unless its SHA-256 is the pinned release's.

| Tool or data | Version | Licence | Why |
|---|---|---|---|
| cosign (Sigstore) | 3.1.3 (SHA-256 pinned for linux-amd64/arm64 and darwin-amd64/arm64, from the release's `cosign_checksums.txt`) | Apache-2.0 | Keyless signing in the publish job (GitHub OIDC token, Fulcio certificate, Rekor entry); offline verification (`verify-blob-attestation` with a trusted root file) everywhere an engine image is used. The same release as above. |
| Sigstore public-good trusted root (`trusted_root.json`) | as fetched by `cosign initialize` through the Sigstore TUF repository at each recorded publish | Apache-2.0 (sigstore/root-signing) | Committed as `engines/signatures/trusted_root.json` by `engine-images-lock.mjs --apply`, so an air-gapped install verifies with no network. |
