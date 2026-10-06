# Delivery plan after D4 (2026-10-06)

Decision record: [ADR-0183](../decisions/0183-post-d4-delivery-plan.md). This plan consolidates STATE.md follow-ups,
PENDING.md, ROADMAP §7.2 / §8.3 / §9, PathForward's waves, and ADR-0177 §4 into one order. It is ranked by what a first
customer install exposes, times the cost to close.

**Where we start:**
- `main` is at 3db120a: 4,521 gateway tests, and `demo:prepare` passes 19/19.
- Every setting ships strict.
- The next migration is 0169, and the next ADR is 0184.

**Rules for every batch:**
- one branch and one PR;
- a red-proof test for every rule (the test fails with the rule reverted);
- strict defaults, with every relaxation audited through `detail.transitions`;
- open source first (ADR-0176);
- a security review before merge;
- a merge commit carrying the full head SHA, then `dhruv/active` fast-forwarded;
- no production designation without the owner's in-session sign-off.

Size key: **S** about half a session, **M** one session, **L** two to three sessions, **XL** its own multi-session
epic.

---

## Batch 1: Trust our own build (S/M), running now

Sources: PathForward PF-04 and Wave 0, ROADMAP I8 and I5's CI half, PENDING S4. Runs in parallel with batch 2.

**Problem.** We ship a security-governance product, yet our own CI does no SAST, secret, dependency or container
scanning, and produces no SBOM or signature. The ISACA pack we now ship would fail us on checklist item 13. Every later
batch merges through this gate, so it comes first.

**Build:**
1. **SAST.** CodeQL (`github/codeql-action`) for TypeScript, or Semgrep OSS with a pinned ruleset if CodeQL is
   unavailable on this plan. Findings are triaged, and the gate fails on new high findings only.
2. **Secret scanning** with gitleaks (MIT), pinned by digest, over the diff and the full history. It runs with the
   allow-list the test suite needs: synthetic secrets only.
3. **Dependency audit.** `pnpm audit --audit-level=high` runs with a reviewed allow-list file. Each entry carries the
   advisory id, the reachability argument already in PENDING S4, and an expiry date. An expired entry fails the gate.
4. **Container scan.** Trivy (Apache-2.0) runs on the built image, pinned by digest with its signature verified,
   because a widely used scanner shipped malicious releases in March 2026.
5. **SBOM.** CycloneDX for the workspace and the image, attached as a CI artifact.
6. **Signing.** cosign keyless signing of the image in CI, plus a verify step. Release-key signing stays with S3 (the
   offline key ceremony is the owner's).
7. **Pinning.** Base images by digest, and `packageManager` pinned to the version CI actually runs (this fixes the pnpm
   10 vs 11 mismatch PathForward records). Third-party GitHub Actions pinned by commit SHA.
8. A `SECURITY.md`, and `docs/ops/SECURITY_CI.md` saying what each gate proves and what it does not.

**Evidence (red proofs in a throwaway branch).** Each case must fail the gate:
- a planted synthetic AWS key;
- a fixture depending on a known-vulnerable version;
- an unsigned image at the verify step;
- an expired audit allow-list entry.

**Owner touchpoints.** If CodeQL needs GitHub Advanced Security on a private repo, Semgrep OSS is the fallback. That
choice is recorded, not asked.

---

## Batch 2: The debt tail (S each, M total), running now

Six items, none touching `schema.ts` or the migration journal, so batches 1 and 2 cannot collide.

| # | Item | Build | Evidence |
|---|---|---|---|
| 2.1 | **`otpauth` replaces the hand-written TOTP** (ADR-0181 follow-up, ADR-0176) | Swap the generator and verifier for `otpauth` (MIT). Keep the window, the replay protection and the enrolment URI format. Add it to `THIRD_PARTY.md`. | The existing TOTP tests pass unchanged; an RFC 6238 test-vector test; a replayed code is still refused. |
| 2.2 | **MRM staleness comparison in SQL** (ADR-0181 follow-up) | Move the "candidate runs since certification vs certification-era runs" comparison into one query. | Identical staleness results on a seeded fixture, old against new; the existing staleness suite passes. |
| 2.3 | **Tailored refusal messages in the web app** | The web app shows specific messages for 403 `mfa_enrollment_required` on a key, 409 key issue to an un-enrolled user, and `ai-literacy-not-current` outside the interstitial. Each says what to do next and links to it. | Mock Playwright specs per message, axe in light and dark; the generic error no longer appears for these codes. |
| 2.4 | **Shard the mocked Playwright suite** | Split the about-18-minute serial suite into shards in `demo.yml` and `ci.yml`, each on its own fresh database, keeping the spec order inside a shard (M-068). Bring the demo-journey cap back down. | Every spec runs exactly once across the shards (a CI step checks the count); wall time measured and recorded. |
| 2.5 | **SeaweedFS replaces the frozen MinIO image** (ADR-0183 §3) | First run the ADR-0060 real-bucket Object Lock suite against SeaweedFS locally. Switch CI and `docker-compose.yml` only if every test passes. | The ADR-0060 attack suite passes against SeaweedFS in CI; if it does not, the MinIO pin stays and the result is recorded. |
| 2.6 | **Outlook send half** (ADR-0183 §5, ADR-0121) | A Microsoft Graph `sendMail` courier carrying the approval request and a portal link (never a decide-by-reply link). It uses a governed `Mail.Send` credential, encrypted, and the Graph host goes through the egress guard. Add `outlook` to `CHATOPS_OUTBOUND_PROVIDERS`; inbound stays refused. Amend ADR-0121. | Against a local fake Graph: registration succeeds; the card is delivered with no decision affordance; the egress refusal works; inbound is still `inbound_unsupported_by_design`; no secret in logs; red proofs. |

---

## Batch 3: Close the holes a buyer finds first (M/L, 1–2 sessions)

Serial after batches 1 and 2. Migration 0169.

1. **I3, memory retention that runs.** A TTL purge sweep for `semantic_cache`, and a conversation retention policy on
   the existing scheduler. The strict default is a short TTL; an admin may lengthen it, and that is audited. The sweep
   never deletes anything an incident or legal hold covers (the D4 evidence-hold rule).
   - *Evidence:* a row past its TTL is gone; a held row stays; a relaxation is audited; the sweep is idempotent.
2. **G5, `/metrics`.** A Prometheus endpoint (`prom-client`, Apache-2.0). It is authenticated and stays off the public
   listener by default. It covers request, decision, upstream and breaker metrics, with labels that carry no personal
   data.
   - *Evidence:* scrape tests, the auth refusal, and a label-cardinality guard.
3. **G3, MCP protocol coverage.** `resources/*`, `prompts/*`, `completion/*`, `logging/*` and notifications become
   governed decisions, not pass-throughs. A resource read is a data-access decision through the kernel, and unknown
   methods stay refused.
   - *Evidence:* deny-by-default per method; a denied call never reaches the upstream (zero-upstream counter).
4. **G4, stdio and SSE upstream transports**, built on the official MCP SDK transports. stdio runs only as an
   admin-registered command with a fixed argument vector, never shell-interpolated, under the existing admission
   scanner.
   - *Evidence:* both transports governed exactly like HTTP; a command-injection attempt is refused.
5. **I9, ownership and memory-store inventory.** Owners on MCP servers and connectors, and memory stores in the
   inventory. This feeds S5's alert-owner derivation.

---

## Batch 4: Stronger approvals and detection content (L, 2 sessions)

1. **I6, dual control and step-up.** A quorum on tool-call approval rules (workflow stages already have one).
   Re-authentication is required at the sensitive action itself, not a login-time MFA attribute.
2. **Passkey-signed approvals** (`@simplewebauthn/server`, MIT). The approver's passkey signs the ADR-0104 action
   digest, and the server re-checks the signature before execution.
3. **A signed receipt per decision** (RFC 8785 canonical JSON, SHA-256, Ed25519), chained to the previous receipt, with
   an offline verifier that separates "invalid" from "could not check".
4. **RFC 3161 timestamps on audit anchors** (`pkijs`, BSD-3).
5. **The trace standards fix** (ADR-0177 step 1): close the six emitter gaps, add the OpenInference profile, and add a
   conformance test against the pinned OTel GenAI version.
6. **Vendored detection content** (ADR-0177 step 2): pipelock's secret patterns and injection normalisation, NeMo's YARA
   rules and the toolkit's MCP heuristics, with attribution and pinned commits. On a match the text is redacted
   (ADR-0183 §4).
7. **Four monitor rules derived from Sentinel's hunting content** (ADR-0177 step 3): MCP-server baseline drift, sharing
   scope widening, instruction change after approval, and jailbreak correlation.

*Evidence:*
- a changed action invalidates the passkey signature;
- a quorum of one is refused where two are required;
- the receipt verifier detects any edit;
- each vendored rule has a true-positive and a false-positive fixture;
- each monitor rule fires only on its scenario.

---

## Batch 5: Sidecar engines (L, 2–3 sessions, one PR per engine)

1. **The PF-23 contract ADR.** Every engine has:
   - a pinned image digest with its signature verified;
   - usage data turned off, with an egress test proving it;
   - deny-by-default egress;
   - a killable timeout;
   - normalised output;
   - `unknown` on error, never "clean";
   - an SBOM entry;
   - a disclosed reduced set when air-gapped.
2. **promptfoo** as the first red-team and eval engine. Its results satisfy A3's required test classes. Cloud-only
   plugins are reported as not run, and the AGPL `pliny` plugin is excluded.
3. **modelscan** behind a model-scanner contract (PF-12).
4. **garak** with an allow-listed probe set, plus the CyberSecEval datasets.
5. **The Engines admin page**, once two engines exist, showing ownership, licence and maintenance re-checks.

---

## Batch 6: Structural work (XL each, one at a time, each with its own ADR)

1. **Per-agent and workload identity** (I7, PF-02). An agent principal in the ABAC schema, and identity on every
   agent-to-agent and MCP hop. It touches the kernel, so it goes slowest.
2. **Decision BOM and AI BOM v1** (PF-09, CycloneDX ML), including training-data sources and per-model data flow.
3. **Isolation** (PF-06): an OpenShell spike behind execution profiles, with task-scoped credentials.
4. **Multi-tenancy** (G10), only when a second customer needs one deployment.
5. **Content provenance and trust levels** (I4): low-trust content cannot carry high action authority.

---

## Owner-gated (not scheduled by a session)

- **P2:** HA, and any production designation (standing guardrail).
- **P3:** SOC 2, ISO 27001 or ISO 42001 attestation spend.
- **S3:** the release-key ceremony.
- The third-party pen test, WAF/DDoS and HSM/FIPS.
- **ROADMAP Batch C:** real BYOC execution (needs a named account).
- Provider breadth, only when a real target is named.
- Repository visibility.
- ADR-0177's open questions on fickling and on offensive tooling.
