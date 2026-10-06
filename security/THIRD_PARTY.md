# Third-party tools in our own security CI (ADR-0184)

These run only in `.github/workflows/security.yml`, unmodified, against our own code and image. None is a dependency of
the product, none is copied into the image, and none runs in a customer install, so ADR-0176's licence rule for shipped
code does not apply; the licences are recorded anyway. Pins are in `security.yml` (versions, SHA-256, commit SHAs) and
the bump procedure is in `docs/ops/SECURITY_CI.md`.

| Tool | Version | Licence | Why |
|---|---|---|---|
| CodeQL CLI and its bundled query packs (via `github/codeql-action`) | CLI 2.27.1, action v4.38.2 | CLI: GitHub CodeQL Terms (free for public repositories and research; not open source). Queries and the action: MIT | SAST for JavaScript/TypeScript and for the workflows. Chosen over Semgrep OSS because the repository is public, so CodeQL is available without GitHub Advanced Security, and it is already the engine behind the repository's Security tab (default setup), so the gate and the alerts agree. Semgrep OSS (LGPL-2.1 engine, rules under their own licences) is the recorded fallback if the repository goes private. |
| gitleaks | 8.30.1 | MIT | Secret scanning over the diff and the full git history. |
| Trivy | 0.74.0 | Apache-2.0 | Container image vulnerability scan and CycloneDX SBOMs of the workspace and the image. Its vulnerability database is downloaded at run time (data from the upstream advisory sources under their own terms). |
| cosign (Sigstore) | 3.1.3 | Apache-2.0 | Verifies Trivy's release signature; keyless signing and verification of our image. Uses the public Fulcio and Rekor instances. |
| registry (CNCF Distribution) | 3 (pinned by digest) | Apache-2.0 | A throwaway local registry inside the job, so cosign can sign and verify without publishing anything. |
| `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact` | v6.0.3, v6.5.0, v7.0.1, v8.0.1 (pinned by commit) | MIT | Standard GitHub Actions plumbing. |
