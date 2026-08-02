# ADR-0041 — BYOC / air-gapped single-tenant-per-deployment as the PRIMARY go-to-market motion

- **Status**: Proposed
- **Date**: 2026-08-01
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
