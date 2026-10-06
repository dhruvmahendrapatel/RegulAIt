# ADR-0184: Our own security CI (batch 1, "trust our own build")

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** owner (batch order and scope, ADR-0183); tool choices recorded here as the plan allowed
- **Builds on:** ADR-0183 §1 and §2 (batch 1; the PENDING S4 deferral on our own scanning is lifted), ADR-0176 (open
  source first), ADR-0180 §1 (secure by default), ADR-0167 (CFG-07 digest pin, SEC-02 xmldom override), PathForward
  PF-04, ROADMAP I8 and I5's CI half

## Context

ADR-0183 §2 ended the 2026-08-01 deferral of SAST, dependency, secret and container scanning in our own CI (PENDING S4,
"D3"). We ship a security-governance product, yet our CI ran none of these, produced no SBOM and signed nothing, and
every later batch merges through whatever gate exists. The delivery plan's batch 1 lists the build: SAST, gitleaks,
`pnpm audit` with a reviewed allow-list, a container scan, CycloneDX SBOMs, cosign keyless signing, digest and SHA
pinning, `SECURITY.md` and an ops page. The owner left one choice to be recorded rather than asked: CodeQL, or Semgrep
OSS if CodeQL needs GitHub Advanced Security on a private repository.

Facts found while building it (2026-10-06):
- The repository is **public** (the GitHub API reports `"visibility": "public"`), and CodeQL **default setup** is
  already enabled (the `dynamic/github-code-scanning/codeql` workflow is active).
- `pnpm audit` is clean at every severity. The HIGHs PENDING S4 listed (fastify, drizzle, fast-uri, ip-address,
  js-yaml, react-router) were fixed by the 2026-10-03 dependency batch; re-checked against the lockfile (fastify 5.12.5,
  drizzle-orm 0.45.3, react-router 7.18.4, ip-address 10.7.3, js-yaml 4.3.2), not copied.
- The pinned **pnpm 10.33.0 itself** has eleven HIGH/CRITICAL advisories in Trivy's database, fixed by 10.34.5.
- CI already ran the pinned pnpm (`pnpm/action-setup@v4` reads `packageManager`); the 10-vs-11 mismatch PathForward
  records was on a review host, and `scripts/verify-clean-checkout.sh` already checks it.
- The `node:22-slim` (Debian 12) base carried seven fixable HIGH/CRITICAL CVEs in `perl-base`, and npm's bundled
  dependencies in every Node 22 image carried fixable HIGHs. `node:22-trixie-slim` (Debian 13) carried none in the OS.
- Trivy releases were compromised in March 2026 (a malicious v0.69.4 binary, force-pushed `trivy-action` and
  `setup-trivy` tags, and malicious Docker Hub images v0.69.5/0.69.6), from a stolen credential.

## Decision

A new workflow, `.github/workflows/security.yml`, runs on every pull request (docs-only ones included), every push to
`main`, weekly, and on demand. Every gate fails closed. `docs/ops/SECURITY_CI.md` says what each proves and does not.

### 1. Tools

| Gate | Tool | Licence | Why this one |
|---|---|---|---|
| SAST | CodeQL, JavaScript/TypeScript and Actions, default query suite | CLI: GitHub CodeQL Terms (free for public repositories); queries and action: MIT | The repository is public, so CodeQL needs no Advanced Security; it already backs the Security tab, so gate and alerts agree. **Semgrep OSS** with a pinned ruleset is the fallback if the repository goes private. |
| Secrets | gitleaks 8.30.1 | MIT | The plan's choice; one static binary; scans git history natively. |
| Dependencies | `pnpm audit --audit-level=high` | MIT (pnpm) | The plan's choice; the same advisory source Dependabot uses. |
| Image and SBOM | Trivy 0.74.0 | Apache-2.0 | One tool for the image scan and both CycloneDX SBOMs (it reads `pnpm-lock.yaml` and image filesystems). Syft would add a second tool for no gain. |
| Signing | cosign 3.1.3, keyless | Apache-2.0 | The plan's choice; no key to manage; GitHub OIDC identity, public Rekor log. |

All are CI-only tools, run unmodified and never shipped (security/THIRD_PARTY.md). The allow-list gate,
`scripts/security-gate.mjs`, is our own code because no tool gives the property it exists for: Trivy's
`.trivyignore.yaml` `expired_at` silently stops ignoring, pnpm's `auditConfig.ignoreGhsas` has no reason or expiry, and
CodeQL has no expiring baseline. None fails on an expired or stale exception.

### 2. How the gates behave

- **SAST.** CodeQL runs with `upload: never`, because GitHub refuses an advanced-setup upload while default setup is on.
  The job gates on the SARIF: any result with `security-severity` ≥ 7.0 not in `security/sast-allowlist.json` fails
  ("new high findings only"). An entry names the rule, the file and the result's
  `partialFingerprints.primaryLocationLineHash`, so it never covers a new result of the same rule in the same file. A
  run that did not execute, scanned no file, or has a result with no rule metadata or no fingerprint fails closed.
  `CODEQL_ACTION_DIFF_INFORMED_QUERIES=false`: by default codeql-action runs path-problem queries "diff-informed" on a
  pull request, reporting only results on changed lines. PR #131's first run therefore reported five baseline entries
  (the three taint-tracking rules) as stale; the gate needs the full result set on every event, so CI and a local
  `codeql database analyze` with the same bundle and suite now agree. The baseline was triaged finding by finding
  (below).
- **Secrets.** gitleaks scans the PR or push range and the full history of the checked-out commit (another branch is
  scanned by its own PR), redacted (the CI logs are public), with `--ignore-gitleaks-allow`.
  `.gitleaks.toml` keeps the default rules and allows only (path AND exact value) pairs: the synthetic secrets our
  scrub, DLP and redaction tests use, and four non-secrets the generic rule misreads. A real secret in an allow-listed
  test file is still caught. Two header-only PEM inputs, whose lazy matches span code, are allowed only in the exact
  commits that introduced them (any later change is scanned with no exception).
- **No scanner side door** (review B1-01). Each scanner also honours its own suppression file with no reason or
  expiry. `scripts/security-suppressions.mjs` fails on `.gitleaksignore`, `.trivyignore`, `.trivyignore.yaml`,
  `trivy.yaml`, `trivy.yml` anywhere in the tree and on `auditConfig` in a `package.json` `pnpm` block or in
  `pnpm-workspace.yaml`; gitleaks ignores inline `gitleaks:allow`; Trivy runs from an empty directory.
- **Allow-lists** (`security/audit-allowlist.json`, `image-allowlist.json`, `sast-allowlist.json`): each entry has the
  advisory or rule id, the package or file it covers, a reason of at least 40 characters, `reviewedOn`, and `expires`
  no more than 90 days later; `reviewedOn` may not be in the future, so the 90 days run from today at most. An expired
  entry fails the gate on its expiry day; a stale entry (matching no current finding) fails it too. A PR that changes
  an allow-list, `.gitleaks.toml`, `security.yml`, the Dockerfile or a `scripts/security-*` gate script gets a warning
  and the diff in the job summary, because a gate stored in the repository can be edited by the PR it gates.
  `.github/CODEOWNERS` proposes the owner as required reviewer for those paths.
- **Image.** The job builds the image, writes both SBOMs, and fails on a fixable HIGH or CRITICAL not allow-listed, or
  on a scan that found no OS or no Node packages (`--expect-classes`). It also fails if the runtime image holds a build
  tool or package manager (`scripts/security-runtime-contents.mjs`, run inside the image).
- **Production-only runtime image.** The first CI run on PR #131 failed the Trivy gate: 22 HIGH/CRITICAL (one
  CRITICAL, CVE-2025-68121) in Go stdlib 1.23.12 compiled into `@esbuild/linux-x64@0.25.12/bin/esbuild`. My local
  proof had not seen it because Docker is unavailable here: I scanned the base image (remote) and `trivy fs` over a
  source export, and a lockfile scan reads package versions, not the Go binary that only exists after install. A
  `trivy rootfs` of a fully installed tree reproduces the same 22. esbuild is a build tool (vite, vitest, drizzle-kit);
  nothing at runtime uses it. The Dockerfile is now two stages: `build` installs, builds, then reinstalls offline with
  `--prod --filter "@regulait/gateway..."`; `runtime` copies that tree. Locally the pruned tree has no build tool
  (409 packages; `node_modules` 501 MB to 336 MB), `trivy rootfs` finds 0 at the gate threshold, every bare import in
  the runtime `dist` resolves, and `demo:prepare` (19/19) plus the real demo journey (2/2) pass when run from it.
- **Signing.** On a push to `main`, after every other job passed, `sign` loads the exact scanned image (image ID
  checked), pushes it to a throwaway local registry, signs it keylessly and verifies it with
  `scripts/security-cosign-verify.sh`, which pins the identity to `security.yml@refs/heads/main` and the GitHub issuer
  and verifies by digest only. On every other run the same script must **refuse** the unsigned image, and refuse it
  with cosign's "no signatures found"; any other failure is inconclusive and fails the job. Nothing is published here:
  signing what we publish belongs in `publish-image.yml` (an integrator follow-up). `infra/release-keys/` and the
  offline release-key ceremony (PENDING S3) are untouched.

### 3. Pinning

- Every third-party action in `security.yml` is pinned by commit SHA. The other workflows are not edited here (their
  owners are batch 2); the exact pins are an integrator follow-up.
- Scanner binaries: version plus SHA-256 in `env`. Trivy is also verified against its Sigstore bundle with the signer
  pinned to `aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.74.0`. That proves where it was
  built, not that the tag was benign (a compromised maintainer credential can run that workflow); the SHA-256 of a
  vetted release is the real control. gitleaks and cosign are verified by SHA-256 only (cosign verifying itself would
  be circular), and that is accepted. The job uses no
  `trivy-action`, no `setup-trivy` and no Trivy container image. Releases are chosen at least about two weeks old
  (Trivy 0.74.0 is from 2026-08-14 rather than 0.75.0 from 2026-10-01).
- **Base image:** `node:22-trixie-slim@sha256:154ba2f4…a98dfa` (published 2026-10-06), replacing
  `node:22-slim@sha256:43ac6c60…b772c`. The `22-slim` tag's current digest (`sha256:c3de60bf…978392`, Debian 12) still
  carried the perl-base CVEs, so the base moves to Debian 13 rather than allow-listing them. npm and npx are removed from
  the runtime stage, and pnpm exists only in the build stage: the runtime runs only `node` and `sh`.
- **pnpm:** `packageManager` moves from 10.33.0 to **10.34.5** (2026-07-10), the first 10.x release with all eleven
  advisories fixed. The lockfile does not change (`pnpm install --frozen-lockfile` with 10.34.5: "Already up to date").
  The `dependencies` job installs pnpm through corepack and fails if `pnpm --version` differs from the pin.

### 4. SAST baseline triage (2026-10-06)

CodeQL 2.27.1 found 27 results at security-severity ≥ 7.0 on `main` @ 3db120a (Actions: none, including `security.yml`). ADR-0180 rule applied: every real finding is fixed in this batch, and only false positives are baselined. After the fixes, CodeQL finds 15 results, in 10 (rule, file) entries, all false positives, and the gate passes with no stale entry.
- **Fixed in this batch** (every `js/polynomial-redos`, each with a timing test on a pathological input that fails
  with the old regex restored, and an equivalence test against the old regex on generated and representative inputs):
  - `packages/optimizer-kernel` `preprocessReference`: user-supplied reference text; 400,000 tabs after a fence held
    the event loop for 172 s (1ad61c5).
  - the fenced-JSON and first-brace extraction from model replies in `access-recommendations`, `copilot`, `evals` and
    `groundedness`: 400,000 characters took about 21.6 s per parser. Replaced by `fencedBlockBody` and
    `firstBraceBlock` in `packages/shared/src/linear-scan.ts`.
  - the trailing-slash trim of a path from an uploaded discovery log (`mcp-discovery`, 149 s on 400,000 slashes) and
    of the git providers' base URLs (Azure DevOps, Bitbucket, GitLab; 140.6 s for the three on 400,000 slashes), by a
    backward scan (`trimTrailingSlashes`).
  - review B1-04: `mcp-discovery`'s bare `host:port` regex restarted a greedy run at every word boundary (`ab.ab.…`:
    111.5 s on 400,000 characters); `bareHostBeforePort` finds the same host by scanning back from each port.
    Following that path into the evidence scrub found one more: `detectPII`/`redactPII` scanned `EMAIL_RE` with
    `RegExp.exec`, quadratic on a long run with no usable `@` (404 s on 400,000 characters), on the path every
    guardrailed prompt takes. `visitEmails` finds the same matches in one pass. Both have equivalence tests against
    the original regex (20,000 generated inputs each) and timing tests that fail with the regex restored.
- **False positives, allow-listed for 90 days** (one entry per result, by fingerprint): the CSP inline-script hasher reading our own build output; a
  specificity tie-breaker mistaken for a sanitizer; the pending-MFA cookie and `hashToken` (already triaged on PR #117:
  opaque 192–256-bit server tokens); `constantTimeEqual`'s pre-hash; the SPA file server's contained path; URL-substring
  checks inside test mocks.

### 5. Not covered

The third-party penetration test, WAF/DDoS at the edge, and the HSM/FIPS option stay deferred (ADR-0183 §1, the
owner's production set). This CI does not prove authorization logic, business rules, the absence of a malicious
dependency without an advisory yet, the safety of images we do not build, or anything about the image a user later
pulls (until `publish-image.yml` signs what it publishes). Medium and low findings are left to Dependabot and the
Security tab. Trivy's vulnerability database is downloaded at run time without a signature check.

## Red proofs (2026-10-06)

Run locally with the pinned tool binaries on planted fixtures in a scratch directory, except where marked CI.

| Case | Result |
|---|---|
| Synthetic AWS key-shaped value (`AKIA` + `SYNTHETICREDPRF7`, assembled at plant time) committed to a new file and appended to an allow-listed test file | gitleaks exit 1, two `aws-access-token` findings; the (path AND value) exception did not cover the new value |
| Full history (1,419 commits, all branches) with `.gitleaks.toml` | `no leaks found`; without it, 42 findings, all synthetic or non-secret |
| Fixture depending on `lodash@4.17.20`, `minimist@1.2.5` | `NOT ALLOWED: GHSA-xvch-5gv4-984h — critical minimist >=1.0.0 <1.2.6 …`, `GATE FAILED (pnpm-audit)`, exit 1 |
| Allow-list entry for that advisory with `expires: 2026-10-01` | `EXPIRED allow-list entry GHSA-xvch-5gv4-984h (package minimist) expired on 2026-10-01 …`, exit 1 |
| Trivy report of `node:22-slim` (Debian 12) | `NOT ALLOWED: CVE-2026-13221 — CRITICAL perl-base 5.36.0-7+deb12u3 -> 5.36.0-7+deb12u4 …`, exit 1 |
| Trivy tarball with one byte appended | `sha256sum: WARNING: 1 computed checksum did NOT match`; cosign `invalid signature when validating ASN.1 encoded signature` |
| Trivy bundle checked against the v0.75.0 identity | cosign `no matching CertificateIdentity found … expected SAN … v0.75.0, got … v0.74.0` |
| Unsigned image in a local registry, verify expecting `signed` | `Error: no signatures found`, `::error::cosign verify REFUSED …`, exit 1 |
| Image signed with a developer key, verify expecting `signed` | `no matching attestations …`, refused, exit 1 |
| Unsigned image at the verify step, on every PR (CI) | the `image` job passes only if verify printed `no signatures found` |
| Keyless sign and verify on `main` (CI) | first proven on the first push to `main` after merge; not runnable here (no OIDC, no Docker daemon) |
| ReDoS fixes, old regexes restored in the 8 files | timing tests fail: each judge parser about 21.6 s, `findMcpEndpoints` 149 s, the three git adapters 140.6 s (`expected 140595.87 to be less than 1000`); restored, all pass |
| **First CI run on PR #131 (CI)**: the image gate | failed as designed: 22 `NOT ALLOWED` Go stdlib CVEs (1 CRITICAL) in the esbuild binary; reproduced locally by `trivy rootfs` of an installed tree (22, exit 1); the production-only tree gives 0 |
| Runtime-contents check on a fully installed tree vs the production-only tree | `BUILD TOOLS IN THE RUNTIME IMAGE (23): @esbuild+linux-x64@0.25.12 …`, exit 1; pruned tree: `runtime contents clean: 409 packages`, exit 0 |
| `// gitleaks:allow` on a planted synthetic key | without `--ignore-gitleaks-allow`: `no leaks found`; with it: `leaks found: 1`, exit 1 |
| `.gitleaksignore`, `.trivyignore`, nested `trivy.yaml`, `pnpm.auditConfig`, workspace `auditConfig` (unit tests on scratch repos) | each `SCANNER SUPPRESSION: …`, exit 1 |
| A synthetic PEM block after the allowed header, in a new commit | `leaks found: 1`, exit 1 (the commit-pinned exception does not cover it) |
| Two results of one rule in one file, one fingerprinted entry (review B1-02) | `NOT ALLOWED: js/sql-injection … (fingerprint cccc3333dddd4444:1)`, exit 1 |
| `reviewedOn: 2099-01-01` (review B1-03) | `reviewedOn 2099-01-01 is in the future`, exit 2 |
| SARIF with no runs, a failed run, no artifacts, an unknown rule or no fingerprint; Trivy report with no `os-pkgs` (B1-06, B1-07) | `GATE ERROR`, exit 2 |
| B1-04 host regex and the email scan restored | timing tests fail: `expected 111540.10 to be less than 1000`; `ab.ab.ab.ab.: expected 404101.46 to be less than 1000` |
| Gate unit tests, rule reverted | expiry check disabled: 3 tests fail; unlisted-finding check disabled: 7 tests fail |

## CI notes from PR #131

- The first `demo-journey` run (job 112483989979, attempt 1, head 9d2503f) failed at `demo-intake.spec.ts:179`: after
  "Evaluate now" the page showed only its loading status for 15 s. Attempt 2 of the same job on the same SHA passed
  (267 + 2 passed), and three local runs of the real journey on that SHA (two on the full tree, one on the
  production-only tree) passed; `POST /v1/governance/monitor/evaluate` answers in about 0.2 s locally. The evaluation
  path does not use any code this batch changed (the reviewer's 300,000-case fuzz of the new parsers against the old
  regexes found no difference). The failing attempt's gateway log is in that run's `demo-journey-failure` artifact,
  which this environment cannot download, so the root cause is not established; it is recorded here, not called a
  flake (M-070).

## Consequences

- Every PR now pays for four extra jobs. The repository is public, so standard runners do not draw on the minutes
  budget `ci.yml` describes.
- The SAST baseline's false-positive entries expire on 2027-01-04. On that day the gate (and `ci.yml`'s script tests)
  fail until each is re-argued. That is intended.
- A PR can still edit its own allow-list. The warning makes it visible; a CODEOWNERS rule on `.gitleaks.toml`,
  `security/` and `.github/workflows/` would make it a required review (owner decision).
- Follow-ups for the integrator: SHA-pin the actions in `ci.yml`, `demo.yml`, `integrations.yml` and
  `publish-image.yml`; sign and verify in `publish-image.yml`; digest-pin the Postgres service images; mark the
  security jobs as required checks; enable GitHub private vulnerability reporting (SECURITY.md points to it).
