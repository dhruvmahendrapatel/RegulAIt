# ADR-0041 — BYOC / air-gapped single-tenant-per-deployment as the PRIMARY go-to-market motion

- **Status**: Accepted
- **Date**: 2026-08-01 (accepted 2026-08-02 — see the implementation amendment at the end)
- **Relates to**: ADR-0007/0008 (eight P0 pillars — pillar 3), ADR-0015 (BYOC / air-gapped
  deploy modes + control-plane / agent-execution-plane data boundary), ADR-0013 (single-EC2
  compose dev-app shape), ADR-0021 (`org_settings` singleton configurability layer), ADR-0034
  (custom LLM providers behind the egress guard — the air-gapped model story), ADR-0035 (nightly
  `pg_dump` to S3), GOVERNANCE_LAYER_SPEC §8 (pillar 3)
- **Cross-refs (planned, not yet written)**: ADR-0052 (offline license format + verification),
  ADR-0043 (MCP/OIDC egress posture — a legitimate self-hosted-server story that only matters in
  a single-tenant deployment)
- **Migration**: none — this is a strategic decision that ratifies the architecture the codebase
  already has, not a schema change.

## Context

The product spec (pillar 3, §8.5) lists **three** deployment modes as co-equal: hosted fast-start,
BYOC, and air-gapped. The codebase today reflects that even-handed framing but leans, in every
concrete detail, toward **one control plane per deployment**:

- **The org is a singleton.** `packages/db/src/schema.ts` defines `ORG_SETTINGS_ID = "singleton"`
  and `org_settings` is a one-row table (`org-settings.ts` reads/writes exactly `id = singleton`).
  There is no `tenant_id` on any governed object — roles, users, agents, connectors, MCP servers,
  audit rows, usage events, projects all live in one flat namespace. This has repeatedly been
  noted in passing as "the multi-tenancy gap".
- **BYOC is real and enforced, hosted-multi-tenant is not.** ADR-0015 shipped a `mode`
  (`hosted | byoc | air_gapped`) on `deploy_targets`, a code-enforced data boundary (air-gapped
  retains metadata only), and an assume-role AWS adapter. ADR-0034's egress guard exists
  *specifically* because pillar 3's air-gapped mode needs self-hosted model endpoints
  (`http://vllm.internal:8000`, `http://localhost:11434`) — "a mode whose every supported provider
  is an internet SaaS is not an air-gapped mode".
- **The whole dev-app is single-tenant-shaped.** ADR-0013 deploys one gateway + one Postgres via
  compose on one box. Nothing about it assumes noisy-neighbour isolation, per-tenant key custody,
  or row-level tenant scoping.

So the question is not "how do we bolt multi-tenancy on". It is: **is the singleton org a gap to
close, or is it the correct architecture for who actually buys this product?** RegulAIt's
differentiator (pillar 1 per-user governance, pillar 3 air-gapped, the whole egress-guard posture
of ADR-0034) is aimed squarely at **regulated buyers** — defense, government, healthcare, finance —
who will not accept their prompts, documents, policy state, or audit trail living in a shared SaaS
control plane at all. For that buyer, "multi-tenant hosted SaaS" is not a feature, it is a
disqualifier. Treating the singleton as a defect would mean spending the next several months
building the one thing our target customer refuses to use.

## Decision

**Adopt BYOC / air-gapped, single-tenant-per-deployment as the PRIMARY enterprise go-to-market
motion. Ratify the singleton org (`ORG_SETTINGS_ID = "singleton"`) as the CORRECT control-plane
architecture for that motion, and explicitly DEFER any multi-tenant hosted-SaaS rebuild to a named
later tier that is only funded when a validated segment demands it.**

Concretely:

1. **The singleton org is a decision, not a gap.** One deployment = one customer = one org. Every
   governed object staying un-`tenant_id`'d is now the *intended* shape, not debt. The data
   boundary ADR-0015 enforces is trivially satisfied because there is no second tenant whose data
   could leak into the first. Reviews should stop filing "no multi-tenancy" as a finding against
   the control plane; it is the control plane's operating assumption.

2. **Productize the install as a first-class deliverable.** The strategic bet only pays off if a
   regulated customer can stand up their own control plane without our engineers in the room. That
   requires, as committed follow-up scope (each its own future slice/ADR):
   - **One-command installer.** A single reproducible bring-up of the ADR-0013 compose stack
     (gateway + Postgres + Caddy TLS per ADR-0029) into the customer's own cloud account or
     air-gapped host, parameterized by their `REGULAIT_DATA_KEY`, domain, and OIDC issuer — no
     hand-assembly of env vars.
   - **Offline license** (→ planned ADR-0052). Air-gapped means no license phone-home. The
     installer verifies a **signed, offline license artifact** (customer, entitlement tier, expiry,
     deployment-mode grant) with a bundled public key — no outbound call, graceful read-only
     degrade past expiry rather than a hard stop, consistent with §8.5's "degrade to last known
     policy, not everything stops".
   - **Signed / verifiable update bundles.** Fleet lifecycle (GOVERNANCE_LAYER_SPEC §8.2) across
     many customer-hosted deployments means updates must be **cryptographically verifiable offline**
     before apply. An update is a signed bundle the customer's deployment checks against a pinned
     public key — the same supply-chain posture ADR-0034's pinned-fetch amendment took ("this code
     sits in the security path, so it earns more scrutiny, not less") and CI takes on third-party
     actions.
   - **The disclosed control-plane / agent-execution-plane data boundary** (pillar 3, §8.4) becomes
     a **sellable trust artifact**: in single-tenant BYOC/air-gapped, prompt and document *content*
     never leaves the customer boundary because there is no external control plane for it to leave
     to. We publish precisely what (if anything) crosses the boundary — in air-gapped, nothing.

3. **Hosted fast-start stays, but as an on-ramp, not the destination.** ADR-0015's `hosted` mode
   remains for pilots and evaluation. It is explicitly a *single-tenant instance we happen to
   operate for you*, not a shared multi-tenant SaaS — so the §8.5 "no-rebuild upgrade path from
   hosted to BYOC" is real precisely because both are the same single-tenant artifact in a
   different location.

4. **Defer the multi-tenant rebuild behind an explicit gate.** A genuine multi-tenant hosted tier
   (shared control plane, `tenant_id` on every governed object, per-tenant key custody, row-level
   isolation, noisy-neighbour controls) is a **separate product tier with its own ADR**, funded
   only when a validated non-regulated segment demands shared-SaaS economics. Until then we do not
   pay its complexity or its blast-radius tax.

## Consequences

### Easier

- The singleton stops being a running apology. Every "but there's no tenant scoping" note against
  the control plane is resolved by fiat: correct by design for this motion.
- Sales/trust story sharpens to the buyer we actually differentiate for: "your control plane runs
  in your cloud / air-gap, under your IAM (ADR-0015 assume-role), your key (`REGULAIT_DATA_KEY`),
  and in air-gapped mode nothing crosses the boundary at all."
- Existing investments compound instead of being hedged: ADR-0034's egress guard, ADR-0043's MCP/
  OIDC posture, ADR-0015's mode boundary, ADR-0035's local backups are all *more* valuable, not
  less, when single-tenant-in-customer-cloud is the headline motion rather than an edge case.

### Harder / given up

- **No shared-SaaS economics.** One deployment per customer means per-customer infrastructure and
  per-customer operational surface. We give up the multi-tenant margin story on purpose.
- **Per-customer ops burden** — fleet upgrades, CVE patching, certificate rotation (§8.2) now
  multiply across N customer deployments rather than one shared plane. This is mitigated, not
  eliminated: the customer runs it in *their own* cloud/air-gap under *their* IAM, which is exactly
  the control regulated buyers demand — so the burden is largely *theirs to operate and ours to
  make verifiable*, which is why the signed-update-bundle and one-command-installer scope above is
  load-bearing, not optional polish.
- **The installer, license, and update-bundle work is now committed scope**, not nice-to-have. This
  ADR is only honest if that work is actually funded; naming it here is the commitment.
- **We are betting the segment.** If the validated demand turns out to be non-regulated teams who
  want frictionless shared SaaS, we will have optimized for the wrong buyer and the deferred
  multi-tenant tier becomes urgent. The bet is deliberate and reversible (the deferral gate exists
  precisely so it can be re-opened), but it is a bet.

### Honest limits

- This ADR **decides direction; it does not build the installer, the license format, or the update
  bundle.** Those are named as follow-up slices (ADR-0052 for the license) and remain unbuilt.
- Single-tenant does not by itself make a deployment secure — it removes cross-tenant leakage as a
  class, but every within-deployment control (pillar 1 governance, the egress guard, PII
  enforcement) still has to do its job. This decision narrows the threat model; it does not shrink
  the work inside it.

---

## Amendment — 2026-08-02 (implementation: installer, signed update bundles, data-boundary artifact)

Status moves **Proposed → Accepted**. The decision above is unchanged. This amendment records
exactly what of §2's "committed follow-up scope" is now built, what is deliberately not, and one
finding the work surfaced that the original text did not anticipate.

### Built

1. **One-command installer — `scripts/install.sh`.** A single reproducible bring-up of the
   ADR-0013 compose stack (gateway + Postgres + Caddy per ADR-0029) parameterised by
   `REGULAIT_DATA_KEY`, domain, TLS posture and OIDC issuer.
   - **Preflight**: docker + `docker compose` v2 (v1 is refused by name — the stack uses profiles,
     IPAM `ip_range` pinning and `pull_policy`), daemon reachability, port availability
     (`ss` → `netstat` → a `/dev/tcp` loopback probe), a free-disk floor measured against Docker's
     own root directory, and openssl.
   - **THE DATA-KEY GATE.** Refuses to proceed on a missing or weak key: not exactly 64 hex
     characters, the published `aaaa…` compose default, fewer than 8 distinct hex characters, or
     any block of period ≤ 16 repeated to length. Generates one when absent, prints it in a banner
     that states the ADR-0035 consequence in full (a restore onto a new box without it leaves every
     credential permanently undecryptable), and will not continue interactively until the operator
     types `recorded`.
   - **Modes**: `hosted | byoc | air_gapped`, with `SEED_DEMO` defaulting to 0 on the two customer
     modes so a customer database never sprouts demo users. `air_gapped` **refuses**
     `--tls letsencrypt` outright — ACME is an outbound call and an inbound challenge — and refuses
     to start without pre-seeded images, because `compose up --build` pulls `node:22-slim` and runs
     `pnpm install` against the npm registry. `scripts/build-image-bundle.sh` produces that bundle
     on a connected host; the generated override pins `image: regulait/gateway:<version>` with
     `pull_policy: never` on all three services and the bring-up passes `--no-build`.
   - **Idempotent by construction**: every secret already in the target `.env` is preserved rather
     than regenerated (regenerating the data key bricks credentials; regenerating the Postgres
     password locks the gateway out, since `POSTGRES_PASSWORD` is honoured only on first initdb),
     rendering carries **no timestamp**, and files are compared before writing. Verified: rendering
     twice produces byte-identical output in all three modes.
   - `--check` runs the full preflight + render path and stops before any container is touched.

2. **Signed / verifiable update bundles.** `scripts/build-update-bundle.sh` produces
   `manifest.json` (version, key id, per-file SHA-256) + a **detached Ed25519 signature over the
   manifest** + `payload/`; `scripts/verify-update-bundle.sh` verifies it **offline** against a
   pinned keyring (`infra/release-keys/`) with **no network call at all** — deliberately, since an
   air-gapped deployment has no revocation endpoint or timestamp authority to reach.
   `scripts/apply-update-bundle.sh` verifies into a throwaway directory, demands a backup, preserves
   the previous tree, applies, and re-converges via the installer. No invented crypto: `openssl
   pkeyutl -sign -rawin` (Ed25519), with an RSA/EC `dgst -sha256` fallback so an HSM that cannot do
   Ed25519 is not excluded. The manifest is signed rather than the tarball, because a manifest can
   express *a file was added* and a whole-archive hash cannot.
   **Fail-closed, proven by execution**: modified file, missing file, unlisted extra file, stripped
   signature, correct key id signed with a different private key, valid signature under an unpinned
   key id, path-traversal key id, and a genuinely-signed downgrade — all refused with non-zero exit.
   Pristine bundle and same-version re-apply pass. There is no `--force`.
   Key custody and the four-step rotation order (ship the new public key in a bundle signed by the
   OLD key first; never collapse the steps) are written out in `infra/release-keys/README.md`,
   including the honest disclosure that the shipped key is a **development** key whose private half
   was not retained — the *shape* of a release root, not one.

3. **The data-boundary trust artifact — `docs/deployment/DATA_BOUNDARY.md`.** Every outbound surface
   in the product enumerated and checked against source, per mode, with the greps a customer can run
   to confirm it in five minutes. Confirmed: **no telemetry, no analytics, no crash reporter, no
   update check, no license phone-home, and no RegulAIt-controlled endpoint compiled into the
   product**; boot makes no network call; the SPA loads no third-party asset.

4. **Operator documentation** — `docs/deployment/{README,INSTALL,UPGRADE,BACKUP_RESTORE}.md`, plus
   an annotated `infra/deploy/env.example` (in `infra/deploy/` rather than a root `.env.example`
   because `.gitignore` correctly refuses `.env*`), and a deploy section in the root README.

5. **`docker-compose.yml` parameterised.** The gateway's `DATABASE_URL`, `REGULAIT_DATA_KEY`,
   `REGULAIT_BOOTSTRAP_TOKEN`, `SEED_DEMO` and the db's `POSTGRES_PASSWORD` became
   `${VAR:-<the same dev default>}`. Verified: with no `.env` present the resolved config is
   byte-identical to before, so `docker compose up --build` on a laptop is unchanged.

### The finding: "air-gapped" is network-enforced, not code-enforced, for compiled vendor endpoints

The egress guard (ADR-0034/0043) adjudicates **URLs a human typed**. It deliberately does not
adjudicate an adapter's *compiled* vendor endpoint — `agents-connectors.ts` and
`connection-egress.ts` both say so in the same words: **"NO OVERRIDE MEANS NO CHECK"**. As an SSRF
argument that is correct; you cannot smuggle `169.254.169.254` into a constant. It is not an egress
*policy*.

Consequence, stated plainly because a trust artifact that omits its own weakest point is not a trust
artifact: **on an air-gapped deployment, an operator who configures a built-in provider (`anthropic`
/ `openai` / `google` / `xai`) — including merely by setting `ANTHROPIC_API_KEY` et al. in the
environment — will have the gateway attempt an outbound HTTPS connection to that vendor's public API
carrying the prompt. Nothing in the application refuses it; the network is what stops it.** The same
holds for a connector/git/PM row with no `baseUrl` override.

The accurate claim is therefore *"the application initiates no outbound connection you did not
configure, nothing is configured out of the box, and the network is the backstop"* — not *"the
application cannot egress"*. This is documented in DATA_BOUNDARY.md §4 with the recommended
mitigations (no default route; prefer ADR-0034 custom providers, which **are** guarded, over
built-in providers). Closing it properly is a **mode-scoped egress posture** — a new slice with its
own ADR, in the same place ADR-0015's A4 note already put per-mode policy: pillar 1's rule-scoping
model. It is not built and is not claimed.

### Explicitly NOT this slice

- **The offline license is [ADR-0052](0052-licensing-seats.md) and is not mine to build.** No
  license check exists in the product today, and none was added here. §2's licensing bullet remains
  open. (There is a silver lining for the boundary story: with no license check there is nothing to
  phone home about.)
- Non-AWS backup-destination modules. `infra/modules/backup-target-s3` is AWS-only; the posture it
  implements is portable, the module is not.
- Build provenance / reproducible builds. A signed bundle proves *who signed the manifest*, not
  *what commit it was built from*. No SLSA/in-toto attestation.
- A real release key. See `infra/release-keys/README.md`.

### Verification actually performed

Executed on the implementation host: `bash -n` on all five scripts; the installer's full
preflight+render path in `--check` for all three modes, with the rendered `.env` files diffed
against each other; a byte-identical re-render (idempotency) in all three modes; the resolved
`docker compose config` for the air-gapped render showing `pull_policy: never` and the pinned
gateway image; the no-`.env` resolved config proving the dev defaults are unchanged; the data-key
gate refusing six distinct weak inputs; and the ten update-bundle verifier cases above.

**Not executed: a real `docker compose up`.** The bring-up was attempted end to end and reached
`docker compose up`, where the image pull failed with `403 Forbidden` from the sandbox's egress
policy on Docker Hub's blob CDN (`production.cloudfront.docker.com`). The container-runtime half of
the installer — `docker load`, `up -d --no-build`, the readiness probe — is therefore **syntax- and
config-verified but not runtime-exercised**, and should be run once on a host with registry access
before it is put in front of a customer.
