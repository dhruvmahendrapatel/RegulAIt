# Security policy

regulAIt is a governance product, so a weakness in it is a weakness in every control it enforces. Thank you for
reporting one privately.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a
vulnerability**. That opens a private advisory that only the maintainers can read.

Please do not open a public issue, pull request or discussion for a suspected vulnerability, and do not include a real
credential, token or customer data in a report. A synthetic reproduction is enough.

A useful report says:
- what an attacker can do, and from which position (anonymous, any signed-in user, an administrator, an agent, an MCP
  server, a connected tool);
- the commit or image digest you tested;
- the shortest reproduction you have.

We aim to acknowledge a report within 5 working days and to agree a disclosure date with you once the issue is
understood. We credit reporters in the advisory unless you ask us not to.

## Supported versions

regulAIt has not made a production release. Only the `main` branch is supported, and fixes land there. There are no
release branches to backport to yet; this section will list them when there are.

| Version | Supported |
|---|---|
| `main` | Yes |
| anything else | No |

## What our own CI checks

Every pull request and every push to `main` runs `.github/workflows/security.yml` (ADR-0184):

| Gate | Tool | Fails on |
|---|---|---|
| Static analysis | CodeQL (JavaScript/TypeScript and the workflows) | a high-severity finding (security-severity 7.0 or more) not in the triaged baseline |
| Secret scanning | gitleaks, over the change and the full history | any secret outside the synthetic test values listed in `.gitleaks.toml` |
| Dependency audit | `pnpm audit --audit-level=high` | a HIGH or CRITICAL advisory without a current, reasoned allow-list entry |
| Container scan | Trivy, on the image built from this commit | a fixable HIGH or CRITICAL vulnerability without a current allow-list entry |
| SBOM | Trivy (CycloneDX) | not a gate: SBOMs of the workspace and the image are kept as build artifacts |
| Signing | cosign keyless | on `main`, an image that does not verify against this workflow's identity; on a PR, a verify step that fails to refuse an unsigned image |

Every allow-list entry carries a reason and an expiry date at most 90 days out, and an expired or stale entry fails the
gate. What each gate proves and what it does not is in [docs/ops/SECURITY_CI.md](docs/ops/SECURITY_CI.md).

Not covered by CI, and deferred by the owner: a third-party penetration test, WAF and DDoS protection at the edge, and an
HSM/FIPS option. Release-key signing of update bundles is a separate offline ceremony (`infra/release-keys/`).
