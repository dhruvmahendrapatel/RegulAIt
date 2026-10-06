# Security CI: what each gate proves, and what it does not

Workflow: [`.github/workflows/security.yml`](../../.github/workflows/security.yml). Decision: [ADR-0184](../decisions/0184-own-security-ci.md).
It runs on every pull request (docs-only ones too), on every push to `main`, weekly on Monday at 05:17 UTC, and on demand.

Every gate fails closed. A scanner that cannot run, a report the gate cannot parse, a malformed allow-list, an expired
allow-list entry, and a stale one (an entry that matches no current finding) each fail the job.

## The gates

### 1. SAST: CodeQL (`sast` job)

**Proves:** none of CodeQL's default-suite queries for JavaScript/TypeScript, or for the GitHub Actions workflows, finds
a high-severity issue (`security-severity` of 7.0 or more) that is not in `security/sast-allowlist.json`.

**Does not prove:**
- absence of bugs CodeQL has no query for, such as authorization logic (who may approve what) or business rules;
- anything below 7.0. Medium findings still appear in the Security tab through GitHub's default setup;
- anything about code paths the extractor cannot see (generated code at run time, `eval` input).

**How it runs:** CodeQL default setup is also on for this repository and owns the Security tab. GitHub refuses an
advanced-setup upload while default setup is on, so this job runs with `upload: never`, gates on the SARIF file itself,
and keeps the SARIF as the `codeql-sarif` artifact. The CodeQL bundle is the one pinned by the `github/codeql-action`
commit (CLI 2.27.1 at v4.38.2). The job sets `CODEQL_ACTION_DIFF_INFORMED_QUERIES=false`: otherwise, on a pull request,
the taint-tracking queries report only results on changed lines, and the baseline's entries for them read as stale.

An allow-list entry covers one result: the rule, the file and the result's `partialFingerprints.primaryLocationLineHash`
(a hash of the line's content plus an occurrence index, so it survives the line moving). A new result of the same rule
in the same file is not covered. A run that did not execute, scanned no file, or has a result whose rule or fingerprint
is missing fails the gate (exit 2).

**Reproduce CI locally** (CodeQL bundle `codeql-bundle-v2.27.1` from the `github/codeql-action` releases):

```bash
codeql database create db --db-cluster --language=javascript-typescript,actions --build-mode=none --source-root=.
codeql database analyze db/javascript codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls --format=sarif-latest --output=js.sarif
codeql database analyze db/actions codeql/actions-queries:codeql-suites/actions-code-scanning.qls --format=sarif-latest --output=actions.sarif
node scripts/security-gate.mjs --kind sarif --report js.sarif --report actions.sarif --allowlist security/sast-allowlist.json
```

**Licence note:** the CodeQL CLI is free for public repositories. If this repository becomes private again, the job
needs GitHub Advanced Security, or it is replaced with Semgrep OSS on a pinned ruleset (ADR-0184 records that fallback).

### 2. Secret scanning: gitleaks (`secrets` job)

**Proves:** no commit in the change (PR base..head, or the pushed range) and no commit in the full history of the
checked-out commit (for a PR, its merge into `main`) contains a string matching gitleaks' default rules, except the synthetic values listed in
`.gitleaks.toml`.

**Does not prove:**
- that a secret in a format gitleaks has no rule for is absent (an internal token with no prefix and low entropy);
- anything about secrets outside git: CI variables, developer machines, the container's runtime environment;
- anything about other branches: each is scanned by its own PR (and `main` on every push);
- that a secret removed from history is safe. A leaked secret is rotated, not just deleted.

Output is redacted (`--redact`), because this repository and its CI logs are public. gitleaks runs with
`--ignore-gitleaks-allow`, so an inline `gitleaks:allow` comment does not hide a finding.

**Exceptions** are (path AND exact value), never a path alone, so a real secret pasted into an allow-listed test file
is still caught. Two header-only PEM test inputs, whose private-key matches span code, are also pinned to the commits
that introduced them. A PR that changes `.gitleaks.toml`, anything in `security/`, `security.yml`, the Dockerfile or a
`scripts/security-*` gate script gets a warning annotation and the diff in the job summary: those changes are reviewed
as security changes, and `.github/CODEOWNERS` proposes the owner as their required reviewer.

**No side doors.** `scripts/security-suppressions.mjs` (run first in this job) fails if the tree holds a
`.gitleaksignore`, `.trivyignore`, `.trivyignore.yaml`, `trivy.yaml` or `trivy.yml`, or an `auditConfig` in a
`package.json` `pnpm` block or in `pnpm-workspace.yaml`. Each of those would suppress a finding with no reason and no
expiry. Trivy also runs from an empty directory, so it cannot pick up such a file.

### 3. Dependency audit: `pnpm audit` (`dependencies` job)

**Proves:** the npm advisory database has no HIGH or CRITICAL advisory against any version in `pnpm-lock.yaml`, other
than those with a current entry in `security/audit-allowlist.json`. It also proves the CI pnpm is the version
`packageManager` pins (installed through corepack, which checks the npm registry signature).

**Does not prove:**
- that a dependency is not malicious (a fresh malicious release has no advisory yet; ADR-0181's release-age cooldown is
  the product-side control for MCP servers, not for our own dependencies);
- anything about MODERATE or LOW advisories (Dependabot still raises them);
- reachability. An allow-list entry records a human reachability argument; the gate checks it exists and is current,
  not that it is right.

As of 2026-10-06 `pnpm audit` reports no advisory at any severity. The HIGHs PENDING S4 listed (fastify, drizzle,
fast-uri, ip-address, js-yaml, react-router) were all fixed by the 2026-10-03 dependency batch, so the allow-list is
empty; nothing was copied into it. The `@xmldom/xmldom` 0.8.15 override (ADR-0167) still pins the SAML parser above the
advisories on 0.8.13.

### 4. Container scan: Trivy (`image` job)

**Proves:** the image built from this commit's `Dockerfile` (operating-system packages, every `package.json` and every
Go binary in the final filesystem) has no HIGH or CRITICAL vulnerability that has a fixed version, other than those in
`security/image-allowlist.json`. Unfixable ones are listed in the report but do not fail the gate, because nothing can
be done about them yet. A report with no OS-package or no Node-package result fails (`--expect-classes`): a scan that
saw nothing proves nothing.

**Runtime contents.** The Dockerfile's `runtime` stage holds the gateway's production dependencies only (the `build`
stage reinstalls with `pnpm install --frozen-lockfile --prod --offline --filter "@regulait/gateway..."` before the copy).
`scripts/security-runtime-contents.mjs`, run inside the built image, fails if any build tool (esbuild, vite, vitest,
typescript, tsx, drizzle-kit, playwright, rollup) or a package manager (npm, npx, a corepack pnpm cache) is present.
That is why: the first CI scan (PR #131) found 22 HIGH/CRITICAL Go standard-library CVEs in the esbuild binary the old
single-stage image carried. A lockfile scan cannot see that; only a scan of an installed tree or the image can.

**Does not prove:**
- that the image is safe to run as configured (Trivy's misconfiguration and secret scanners are not enabled here);
- anything about images we do not build (Postgres, the object store, the demo services);
- that Trivy's vulnerability database is complete or current beyond the moment it was downloaded. The database is
  fetched at run time and is not signature-checked by this job.

Trivy itself is pinned by version and SHA-256 and verified against its Sigstore bundle, with the signer pinned to
`aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v<version>`. Trivy releases were compromised
in March 2026 (v0.69.4, and Docker Hub images v0.69.5/0.69.6), which is why this job does not use `trivy-action`,
`setup-trivy` or a Trivy container image.

### 5. SBOM (`image` job)

`sbom-workspace.cdx.json` (from `pnpm-lock.yaml`) and `sbom-image.cdx.json` (from the built image), both CycloneDX, are
uploaded with the Trivy report as the `sbom-and-image-scan` artifact (30 days). They are evidence, not a gate.

### 6. Signing: cosign keyless (`image` and `sign` jobs)

**On a push to `main`**, after every other gate has passed, the `sign` job loads the exact image the `image` job
scanned (it checks the image ID), pushes it to a throwaway local registry, signs it keylessly with this workflow's
GitHub OIDC identity (the certificate comes from Fulcio and the signature is logged to the public Rekor log), and
verifies it with `scripts/security-cosign-verify.sh <ref> signed`. Verify pins the identity to
`https://github.com/<owner>/<repo>/.github/workflows/security.yml@refs/heads/main` and the GitHub OIDC issuer.

**On every other run** (PR, schedule, manual), the `image` job pushes the unsigned image and runs the same script with
`unsigned`: the verify command must refuse it, with cosign's "no signatures found" (or "no matching …") error. A
different failure, such as a network error, fails the job as inconclusive.

**Does not prove:**
- anything about the image anyone later pulls: the signed image lives in the job's throwaway registry. Publishing a
  signed image is `publish-image.yml`'s job (ADR-0184 lists the change it needs);
- release-key signing of update bundles, which stays the owner's offline ceremony (`infra/release-keys/`, PENDING S3).

## Supply chain of the gates themselves

| Item | Pinned how | Where |
|---|---|---|
| Third-party actions | full commit SHA, tag in a trailing comment | `security.yml` |
| gitleaks 8.30.1 | version + SHA-256 of the release tarball | `security.yml` `env` |
| Trivy 0.74.0 | version + SHA-256 + Sigstore bundle with the signer identity pinned | `security.yml` `env` and the install step |
| cosign 3.1.3 | version + SHA-256 of the binary | `security.yml` `env` |
| registry 3 (throwaway) | image digest | `security.yml` `services` |
| node base image | image digest | `Dockerfile` |
| pnpm | `packageManager`, installed by corepack, version checked | `package.json`, `dependencies` job |

Tool licences are in [security/THIRD_PARTY.md](../../security/THIRD_PARTY.md). They are CI tools run unmodified; none is
shipped in the product.

### Bumping a pinned tool

1. Pick a release at least 14 days old with no open report of a compromise.
2. For gitleaks and cosign: download the release asset and its `checksums.txt`; the SHA-256 must match, then put it in
   `env`. For cosign also check `cosign verify-blob --bundle cosign-linux-amd64.sigstore.json` with the identity
   `keyless@projectsigstore.iam.gserviceaccount.com` and issuer `https://accounts.google.com`.
3. For Trivy: put the new version and the SHA-256 of `trivy_<v>_Linux-64bit.tar.gz` in `env`. The workflow verifies the
   Sigstore bundle against the tag itself.
4. For an action: resolve the tag to its commit (`git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>`;
   for an annotated tag use the `^{}` line) and replace the SHA and the comment.
5. For the base image: `docker buildx imagetools inspect node:22-trixie-slim` and replace the digest. The Trivy gate
   must pass on the PR.

## Adding an allow-list entry

Fix the finding if you can. An entry is for a finding that is a false positive, or real but not reachable, or real and
waiting for an upstream fix.

`security/audit-allowlist.json` (pnpm audit), `security/image-allowlist.json` (Trivy) and
`security/sast-allowlist.json` (CodeQL) share one shape:

```json
{
  "entries": [
    {
      "id": "GHSA-xxxx-xxxx-xxxx",
      "package": "the-package",
      "reason": "The reachability argument in full: which code imports it, why the vulnerable function is not reached, or why the input is bounded.",
      "reviewedOn": "2026-10-06",
      "expires": "2026-11-05"
    }
  ]
}
```

- `id`: the advisory id pnpm prints (GHSA), the Trivy `VulnerabilityID` (CVE or GHSA), or the CodeQL rule id.
- `package` (pnpm audit, Trivy) or `path` (CodeQL, the repository-relative file): the entry covers that id in that
  package or file only.
- `fingerprint` (CodeQL only): the result's `partialFingerprints.primaryLocationLineHash` from the SARIF artifact. The
  entry then covers that one result, not a new one of the same rule in the same file.
- `reason`: at least 40 characters. Say why it is safe, not just that it is.
- `reviewedOn`: the day of the review, never in the future.
- `expires`: at most 90 days after `reviewedOn`. On that day the gate fails until someone re-argues the entry or fixes
  the finding. A real finding is fixed, not allow-listed (ADR-0180); an entry is for a false positive or for a fix
  that genuinely waits on someone else, with the shortest expiry that covers it.

Remove an entry in the same PR that fixes its finding: a stale entry fails the gate.

For gitleaks, add an `[[allowlists]]` block to `.gitleaks.toml` with `condition = "AND"`, the anchored file path and
the anchored synthetic value. Use an obviously synthetic value (sequential characters, `test`, `never-echoed`).

## Red-proof procedure

Each gate must be seen to fail. The recorded proofs for ADR-0184 (2026-10-06) are in that ADR. To repeat them:

| Gate | Plant | Expected failure |
|---|---|---|
| gitleaks | in a scratch clone, write a synthetic AWS key-shaped value with `printf 'export const k = "AKIA%s";\n' SYNTHETICREDPRF7 > planted.ts` (assembled at plant time so this page does not trip the scanner), commit it, and append the same line to an allow-listed test file | exit 1, two `aws-access-token` findings (the allow-listed test file is not exempt for a new value) |
| pnpm audit | a scratch project depending on `lodash@4.17.20` and `minimist@1.2.5`; `pnpm audit --json` then `node scripts/security-gate.mjs --kind pnpm-audit …` | exit 1, `NOT ALLOWED: GHSA-xvch-5gv4-984h — critical minimist …` |
| allow-list expiry | an entry with `expires` in the past | exit 1, `EXPIRED allow-list entry …` |
| Trivy | scan `node:22-slim` (bookworm) as of 2026-10-06 | exit 1, `NOT ALLOWED: CVE-2026-13221 — CRITICAL perl-base …` |
| Trivy binary | append one byte to the tarball; or verify the bundle against another tag's identity | `sha256sum: … FAILED`; cosign `invalid signature` / `no matching CertificateIdentity` |
| cosign verify | every PR runs it on the unsigned image | the PR job passes only because verify printed `no signatures found` |
| CodeQL | a SARIF result with security-severity 7.5 not in the baseline (unit test), or revert a fixed ReDoS | exit 1, `NOT ALLOWED: js/… at <file>:<line>` |
| Runtime contents | `node scripts/security-runtime-contents.mjs .` in a full development install | exit 1, `BUILD TOOLS IN THE RUNTIME IMAGE (23): @esbuild+linux-x64@…` |
| Side doors | add a `.trivyignore`, a `.gitleaksignore`, or `pnpm.auditConfig` to `package.json` | `node scripts/security-suppressions.mjs .` exits 1, `SCANNER SUPPRESSION: …` |

`scripts/security-gate.test.mjs` holds the gate's own red proofs and runs in `ci.yml`'s script-test step.
