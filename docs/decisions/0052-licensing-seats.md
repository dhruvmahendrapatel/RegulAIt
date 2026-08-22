# ADR-0052 — Licensing & seats: a signed offline license, seat caps, tier flags, and a split-by-action-class expiry posture

- **Status**: Accepted
- **Date**: 2026-08-01
- **Relates to**: ADR-0041 (BYOC / air-gapped as the primary motion — the reason this must work
  offline), ADR-0014 / ADR-0019 (the per-user entitlement model this enforces seats against),
  ADR-0021 (`org_settings` — settings only ever narrow; a license is a ceiling), ADR-0051
  (metering & billing — seat count is a billing input), the standing **provider-agnostic**
  principle in CLAUDE.md
- **Anchors (already built)**: the per-user entitlement model (pillar 1) already decides which
  users exist and what each may do; the admin console already manages users/roles. A license adds
  a *commercial ceiling* on top of that governance ceiling — it does not replace it.

## Context

RegulAIt's primary go-to-market motion is BYOC and air-gapped (ADR-0041): the control plane —
gateway, policy engine, admin console — runs **inside the customer's own cloud or on-prem
environment**, and in the air-gapped case with no reliable outbound connection at all. That is
precisely the deployment where a conventional "phone home to check the license" scheme cannot
work: there is no home to phone.

Today there is no license concept at all. Anyone who can run the control plane runs it without a
seat cap, without tier gating, without an expiry. For a product sold to regulated enterprises on a
seat-and-tier basis, that is a commercial hole, and — because the deployment is the customer's own
infrastructure — it cannot be closed by a server we control.

Two forces dominate:

1. **Offline verifiability.** The license must be verifiable with no network call, from a locally
   cached artifact, because the flagship deployment has no network. That points at a signed license
   file with an embedded public key, not a license *server*.

2. **Expiry behavior is a genuine dilemma, not a default.** When a license lapses (expiry passes,
   or a grace window runs out), what happens? This is not a throwaway detail for a **governance**
   product:
   - **Fail-closed entirely** (the control plane stops) turns a lapsed invoice into an *AI
     governance outage*: agents that were being gated are now un-gated because the gate stopped,
     and the audit trail stops recording. A billing dispute should never become a security
     incident. Worse, in air-gapped/defense contexts an outage triggered by a date is itself a
     reliability defect.
   - **Fail-open entirely** (everything keeps working forever) removes all commercial leverage and
     lets an unpaid customer run indefinitely.
   Neither is acceptable, and picking one silently would be dishonest. The decision has to reason
   about *which behaviors* fail which way.

## Decision

**Ship a cryptographically signed, offline-verifiable license file; enforce seat caps and per-tier
feature flags against the existing entitlement model; and on expiry, split behavior by action
class — the governance/safety layer fails OPEN, commercial expansion fails CLOSED.**

### 1. The license artifact — signed, offline, self-contained

An Ed25519-signed JSON document (RegulAIt holds the private key; the control plane ships with the
public key compiled in). It contains:

| field | purpose |
|---|---|
| `tenant`, `licenseId` | who this is for |
| `tier` | plan name; drives `features` |
| `seatCap` | maximum entitled users (§3) |
| `features` | per-tier capability flags (§4) |
| `deploymentMode` | `hosted` \| `byoc` \| `airgapped` — an air-gap license may carry a longer grace and no online-refresh expectation |
| `issuedAt`, `notBefore`, `expiresAt` | validity window |
| `graceDays` | length of the post-expiry grace window (§5) |
| `signature` | Ed25519 over the canonicalized body |

Verification is **local**: signature check against the embedded public key, then window check
against the host clock, at boot and on a periodic timer. No outbound call. In hosted mode the file
can be refreshed automatically; in BYOC/air-gapped it is delivered as a file the admin installs,
exactly as an offline audit sync (§8.5) works in reverse. Clock-tampering is an accepted residual
(§Consequences) — an offline license cannot defend against an attacker who owns the host clock,
and pretending otherwise would be the same dishonesty ADR-0034 refused.

### 2. The license is a ceiling, evaluated like every other ceiling

Per ADR-0021, settings only ever narrow. The license is the outermost narrowing: it can never
*grant* an entitlement the governance layer denies, only *cap* what the governance layer would
otherwise allow. Entitlement (pillar 1) decides what a user *may* do; the license decides *how many*
such users and *which tier features* are available. The two are evaluated independently and the
stricter wins.

### 3. Seat caps enforced against the entitlement model

A "seat" is an entitled user — one with any active grant in the pillar-1 model. Seat count is
computed from the same user table the admin console manages, so there is exactly one definition of
"an active user" and ADR-0051's billing consumes that same number. When entitled users would
exceed `seatCap`:

- existing seats keep working (never revoke governance from a user for a seat-count reason);
- **provisioning a new entitled user is refused** with an explicit `seat_cap_reached`, audited,
  surfaced in the admin console with the current/max count and a link to expand the plan.

Seat enforcement is therefore a *growth* gate, not a *service* gate — consistent with §5.

### 4. Per-tier feature flags

`features` gates tier-differentiated capabilities (e.g. air-gapped mode itself, SSO/SAML, the
number of compliance packs, advanced orchestration fan-out). Flags are read at the same points that
already read `org_settings`, and default **closed** for any flag absent from the license — an
older license simply doesn't unlock newer paid features, rather than failing. **Provider-agnostic
invariant preserved:** a feature flag may gate *how many* model providers or PM adapters a tier may
connect, but never *which vendor* — the license never encodes a preferred vendor at any layer.

### 5. Expiry posture — the split, argued honestly

On `expiresAt`, a grace window of `graceDays` opens with escalating admin-console and audit
warnings. When grace runs out, behavior splits by action class:

- **Governance / safety / audit — FAIL OPEN.** Policy evaluation, per-user entitlement checks,
  approvals, PII/guardrail enforcement, and audit logging **keep running unchanged**. A lapsed
  license must never leave AI *less* governed than a valid one. This is the non-negotiable half:
  the safety layer is not a paid feature you can lose by missing an invoice.
- **Commercial / expansion — FAIL CLOSED.** No new seats, no newly connected model providers or
  PM/git connectors, no new agents, no tier-flag features, no policy *expansion* that would widen
  scope. The system freezes at its current committed footprint and keeps enforcing it.

So an expired customer keeps a fully governed, fully audited, fully *enforcing* system that simply
cannot grow, with loud, dated warnings throughout the grace window. This gives real commercial
leverage (you cannot expand, and you are visibly out of compliance with your own license) without
ever converting a billing lapse into a security or reliability incident. A hard, total shutdown is
available only as an explicit, non-default `hardStopOnExpiry` flag a customer can opt into for their
own reasons (e.g. a contractual requirement that the system stop) — it is never the default,
because the default for a governance product must be "stay governed."

### 6. BYOC / air-gapped specifics

The whole scheme assumes no network by design, so BYOC and air-gapped are the *primary* case, not
an exception. An air-gapped license is delivered as a file, verified locally, and carries a longer
default grace so a remote site cannot be knocked offline by a courier delay. Renewal is a new
signed file installed the same way audit events are exported — the offline-first posture ADR-0041
and §8.5 already commit to.

## Consequences

### Easier

- The primary (BYOC/air-gapped) motion becomes commercially enforceable without a license server or
  any outbound dependency.
- Seat and tier become real, from a single seat definition shared with billing (ADR-0051).
- The failure mode is defensible to a security-conscious buyer: "your governance never turns off
  because of our billing" is a *feature*, not a concession.

### Harder / given up

- An offline license cannot defend against host-clock tampering or an attacker who controls the
  control-plane host — that host is the customer's own infrastructure. This is disclosed, not
  mitigated; the license raises the cost of casual overuse, it is not a DRM fortress.
- The split-posture logic is more code than a single on/off switch, and every enforcement point
  must correctly classify itself as safety (fail-open) or expansion (fail-closed). A miscategorized
  path is a real bug and must be covered by tests.
- Key rotation for the embedded public key is a real operational concern (a compromised signing key
  needs a control-plane update to every deployment) and is left as follow-up.

### Follow-up

- Signing infrastructure (key custody for the RegulAIt private key), the license schema, and the
  boot/periodic verifier are specified here but not built.
- The action-class classification (which enforcement points are safety vs expansion) needs an
  explicit, reviewed inventory before implementation.

## Implementation amendment — 2026-08-02 (migration 0064)

Accepted and built. What follows is the honest record of the verification posture, which failures
fail which way and why, and which enforcement points are actually wired.

### THE POSTURE SENTENCE — read this before anything else

**Fail CLOSED on a forgery. Fail OPEN on an absence. Degrade, never brick, on an expiry.**

Those are three different facts and they were decided deliberately, not defaulted:

| situation | answer | why |
|---|---|---|
| **forged / tampered / signed by an unpinned key / malformed body** | **REFUSED outright.** Not installed, audited as a deny, and — critically — it **does not displace the license already in force**. | Displacing a valid license with a forged one (bigger seat cap, unlocked tier, later expiry) *is* the attack. "Refuse and keep the previous state" is the only safe answer. |
| **absent — no license installed at all** | **Runs UNLICENSED.** Governance, approvals, guardrails and audit are fully operational; every tier feature is **closed**; **no seat cap is enforced**; every surface reports `licensed: false`. | There is no authoritative number to enforce, and inventing one would be a fabricated policy. Bricking a fresh install would make the governance layer depend on the commercial one — the exact inversion §5 refuses — and would leave no way to reach the console to install the license. The residual is stated rather than hidden: an operator who never installs a license gets an un-capped but fully governed and visibly unlicensed system. |
| **expired past grace** | **Degrades.** Reads work, governance/audit keep running, **expansion is refused**. | §5's split, implemented literally. |

**What "read-only degrade" means here, precisely.** ADR-0041 §8.5 says "degrade to last known policy,
not everything stops". Read-only is therefore read-only **with respect to growth**: the deployment
cannot add seats, agents, connectors, providers or tier features, while the governance layer keeps
evaluating, keeps enforcing and keeps *writing its audit trail*. It deliberately does **not** mean
"no row is ever written" — an audit log that stops recording because of a billing date is a security
incident caused by an accounting event. Both halves are asserted in the tests.

### What shipped

**Pure half — `packages/shared/src/licensing.ts` (+ 26 unit tests):** the `regulait.license/1`
document schema, `evaluateLicenseWindow` (the four states off the host clock),
`LICENSE_ACTION_INVENTORY` (see below), `evaluateLicensedAction` (the split posture, in ONE place),
`evaluateSeatGrant`, `featureEnabled` (default closed), and the install write shape.

**Gateway half — `apps/gateway/src/licensing.ts` (+ 20 integration tests):** `verifyLicenseArtifact`
(offline Ed25519 via `node:crypto` against a pinned keyring), `resolveLicense`, `licenseGate`,
`seatGate`, `licenseFeature`, the two enforcement helpers, and the routes `POST /v1/licenses`,
`GET /v1/licenses`, `GET /v1/licenses/:id`, `GET /v1/licenses/status`, `POST /v1/licenses/verify`,
`GET /v1/licenses/verifications` — all admin-only through the default gate.

**Migration 0064:** `licenses` (with a **partial unique index keeping exactly one active**, so
"which license is in force" is never a question answered by picking the newest row) and
`license_verifications`.

**Keyring + signer:** `infra/license-keys/` (README + a development public key whose private half was
destroyed on generation) and `scripts/sign-license.sh` — deliberately the twin of
`scripts/build-update-bundle.sh`: same algorithm, same `--key <path>` custody, same "the signature
covers the exact bytes" rule.

**Admin SPA:** `/admin/licensing`, under **Settings** beside Organization — a license is an
org-level ceiling, not a cost report.

### The crypto is ADR-0041's, reused rather than reinvented

Same algorithm (Ed25519), same artefact shape (signed bytes + base64 signature + a `signingKeyId`
naming a `.pub` in a pinned keyring), same refusal vocabulary, same rotation doctrine (a new key is
delivered *in a bundle signed by the old one*; there is no revocation list because an air-gapped
deployment has nothing to check it against). The keyrings are separate — `infra/release-keys/` for
software, `infra/license-keys/` for entitlement — because a release-signing key must not be able to
mint licenses.

Two details worth naming:

1. **The signature covers the EXACT DELIVERED BYTES, not a re-canonicalisation.** §1 says "Ed25519
   over the canonicalized body"; we sign and verify the bytes themselves, exactly as
   `verify-update-bundle.sh` does ("the authority is the SIGNATURE over the exact bytes, not the
   parse"). `canonicalLicenseBytes` exists as a *producer* convenience so two licenses diff cleanly;
   it is not on the trust path. A verifier that re-serialises before checking accepts documents whose
   delivered bytes differ from what was signed — a whole class of bug that simply does not exist here.
   `licenses.document` stores those bytes verbatim, so the row stays independently re-verifiable
   forever; the parsed columns beside it are a read model and never the authority.
2. **The body is parsed only AFTER the signature verifies.** A malformed body from a valid signer is
   a different (and far less alarming) failure than a well-formed body from an unknown one, and the
   two get different `ruleId`s.

**No production signing key was generated.** `regulait-license-dev-2026-08.pub` is a development key
whose private half was created in a scratch directory and **not retained**, exactly as ADR-0041's
release key was. Consequence, stated plainly: **nobody can currently sign a license this repo's
default keyring accepts.** That is the correct fail-closed direction and it means this keyring is the
*shape* of a licensing root, not one. A real keypair must be generated on an offline host before the
first commercial deployment, and the dev key removed in the same change. The tests do not depend on
it — they generate an **ephemeral** keypair in memory and point `REGULAIT_LICENSE_KEYRING` at a
temporary directory, so real crypto is exercised with **no committed secret**.

### One definition of a seat, shared with ADR-0051

`countActiveSeats` lives in `apps/gateway/src/billing.ts` and `licensing.ts` **imports** it. There is
exactly one implementation, so the number a customer is capped at and the number they are billed for
cannot diverge. It honours ADR-0022: a **deactivated user consumes no seat** — they keep every FK,
audit row and history, but cannot authenticate and cannot dispatch, so billing or capping them would
be a real overcharge. Tested directly, including that deactivating frees headroom that was exhausted
a moment earlier and that the user row survives.

Seat enforcement is a **growth** gate, never a service gate. An over-cap deployment (which happens
legitimately when a smaller license is installed onto a larger estate) refuses the *next*
provisioning and touches nobody; the test asserts the active-user count is unchanged after such an
install.

### The action-class inventory is DATA, not scattered conditions

§Consequences says every enforcement point must correctly classify itself and that a miscategorised
path is a real bug. So the classification is `LICENSE_ACTION_INVENTORY` — a reviewable list with a
stated reason per entry, served on `GET /v1/licenses/status` and rendered on the admin page.
`classifyAction` defaults an **unknown** action to `expansion`, the safe direction: a new expansion
path that quietly defaulted to `governance` would be an unlicensed hole.

### Deviations from the proposal above

1. **A missing license does NOT enforce a seat cap.** §3 describes seat caps without saying what
   happens with no license. We chose: unlicensed means uncapped-but-visibly-unlicensed, with all tier
   features closed. The alternative — inventing a default cap — is a fabricated policy, and a
   fail-closed default would brick every fresh install before a license could be installed. Disclosed
   above and on the status API.
2. **Two enforcement points are wired, not the whole §4 surface.** Live today: `user.provision`
   (`POST /v1/users`, seat cap + expansion) and `agent.create` (`POST /v1/agents`, expansion).
   `GET /v1/licenses/status` returns `enforcementPointsWired` so the gap is visible in the product.
   Connector/MCP-server/provider creation, and the SSO/SCIM/compliance-pack tier flags, are
   **modelled and unwired** — they produce no license refusal today rather than a partial one that
   looks complete.
3. **The "periodic timer" of §1 is an ENDPOINT.** There is no in-process scheduler in this codebase
   (ADRs 0044–0051 all landed the same way). `POST /v1/licenses/verify` is what an operator or an
   external cron drives; it re-checks the **signature over the stored bytes** as well as the window,
   so a row edited directly in the database is caught. `lastVerifiedAt` staying null is how a
   deployment that never wires the cron sees that. There is also no boot-time check — the gateway
   does not verify at startup, because a startup failure on a licensing problem is exactly the
   brick §5 refuses.
4. **A license that fails re-verification is RETAINED, not deleted.** Destroying evidence on a failed
   check is the wrong instinct for a governance product. It is recorded loudly in
   `license_verifications` and `audit_log`, and governance continues unaffected.
5. **`hosted` mode refresh is not implemented.** §1 says the file "can be refreshed automatically" in
   hosted mode. Nothing fetches a license, in any mode — that would be the phone-home the whole
   design exists to avoid, and adding it for one mode only would mean two verification paths.
   Installing a renewal is an admin action everywhere.
6. **`deploymentMode` is recorded but not enforced against the running mode.** The grant is stored,
   surfaced and signed; nothing yet refuses to run in air-gapped mode under a `hosted` license.
   Cross-checking it against ADR-0027's A4 deploy-mode dimension is a follow-up.
7. **No `grace` escalation ladder.** §5 describes "escalating admin-console and audit warnings". What
   ships is one `license-grace-warning` audit row per operator-driven check plus a persistent console
   banner — not a schedule of increasingly loud notices, because there is no scheduler and no
   notification transport in this codebase.
8. **Clock tampering is undefended, by design.** Validity is evaluated against the control-plane
   host's clock, which is the customer's own machine. Disclosed in the ADR, repeated in the module
   header, and returned in the status endpoint's own `note` so it reaches an operator rather than
   only a reader of this file.

### What is genuinely verified vs. structural only

**Genuinely verified end to end (20 gateway integration tests over real Postgres, 26 unit tests):**

- **A validly-signed license verifies offline with ZERO network calls.** `globalThis.fetch`,
  `http.request` and `https.request` are replaced with recording, throwing spies for a full
  install → status → verify cycle and asserted never called. A second, structural proof rides
  alongside: `verifyLicenseArtifact` is asserted to be **synchronous** — a function that returns a
  value rather than a promise cannot have awaited a network round trip, whatever a spy observes.
  (`net`/`tls` are deliberately *not* patched: the Postgres pool rides them, and breaking the db
  would prove nothing about licensing.)
- **A TAMPERED license is refused** — the attack is raising `seatCap` and replaying the original
  signature — **and the genuine license is asserted still in force with its original cap.**
- **A license signed by a DIFFERENT key is refused.** The other key's public half is deliberately
  *also* pinned, so this is a genuine cryptographic refusal rather than a key-id lookup miss; both
  failures are covered separately.
- **An UNPINNED key id is refused even with a valid signature**, and a key id shaped like a path
  escape (`../../etc/shadow`) is rejected before it reaches the filesystem.
- **A row edited directly in the database is caught** by the operator-driven re-verification, and is
  retained rather than deleted.
- **An EXPIRED license degrades rather than blocking**: `GET /v1/users`, `GET /v1/agents` and
  `GET /v1/audit` all still answer, the governance action class is still permitted with ruleId
  `license-expired-governance-fails-open`, and both wired write paths refuse with 403 — with the
  refused user asserted absent from the database.
- **Grace keeps everything open** including tier flags; **past grace closes them**.
- **`hardStopOnExpiry` is opt-in**, refuses governance, and still permits reads so the deployment can
  be renewed. It is asserted to default `false`.
- **Seats count ACTIVE users and do not count deactivated ones**; exceeding the cap yields
  `seat_cap_reached` with the active/cap numbers; deactivating frees a seat that is then genuinely
  usable; an over-cap install disables nobody.
- **Re-installing the same artifact is recognised, not duplicated; a new one supersedes and keeps
  the history.**
- **Admin gating** on all six routes, and **audit rows with stable ruleIds**: `license-installed`,
  `license-signature-invalid`, `license-signing-key-not-pinned`, `license-keyring-missing`,
  `license-key-id-malformed`, `license-document-malformed`, `license-expired-no-expansion`,
  `seat_cap_reached`, `license-grace-warning`, `license-expired-warning`.

**Structural only — the shape exists and is honest, but nothing exercises it end to end:**

- **The tier flags themselves.** `featureEnabled` is correct and tested, and `GET
  /v1/licenses/status` reports every flag's state, but **no feature actually reads it yet** — SSO,
  SCIM, compliance packs and orchestration fan-out are not license-gated today.
- **`deploymentMode` enforcement** — recorded and signed, never compared to the running mode.
- **`scripts/sign-license.sh`** — written and shellcheck-clean in shape, but never executed against a
  real private key in CI, because no private key exists. The tests sign with `node:crypto` instead.
- **Boot-time verification** — deliberately absent (deviation 3).

### Follow-ups this slice leaves open

- Generate a real license-signing keypair offline; commit its public half; remove the dev key.
- Wire the remaining §4 flag consumers (SSO/SAML, SCIM, compliance packs, orchestration fan-out) and
  the remaining expansion points (connector, MCP server, model/PM/git connection creation).
- Cross-check `deploymentMode` against ADR-0027's A4 deploy-mode dimension, so an air-gapped install
  under a `hosted` license is refused rather than merely inconsistent.
- Feed the seat count into ADR-0051's `syncSeats` once a billing backend exists that can receive it.
- A grace-window escalation ladder, once a notification transport exists to escalate through.

---

## Amendment (2026-08-22) — the first two §4 tier flags are ENFORCED, not just reported

"Tier flags are correct and reported but no feature reads them yet" is no longer fully true: two
flags now have real enforcement points, chosen as the two §4 consumers closest to real in this
codebase (both surfaces fully exist) and first in this ADR's own follow-up order — **SSO/SAML**
and **SCIM**.

**Where the flag bites — the ENABLING act, never the operation of what exists:**

| flag | enforcement point | stays open on purpose |
|---|---|---|
| `sso_saml` | `POST /v1/auth/saml-providers` (creating a provider is enabling SSO) | sign-in through an existing provider (authentication is governance, fail-open); PATCH/DELETE on existing providers (managing/narrowing committed footprint) |
| `scim_provisioning` | `POST /v1/scim/tokens` (minting a token is enabling provisioning) | already-issued tokens (committed footprint, §5); rotate (narrows exposure) and revoke (offboarding) |

The gate is one helper, `refuseIfFeatureNotLicensed`, the tier-flag twin of
`refuseIfExpansionBlocked`: it calls `featureEnabled` — the same §4 flag reader
`GET /v1/licenses/status` has reported from since this ADR shipped — so **a wired point can never
disagree with what the status API reports**. A refusal is a 403 naming the feature, the tier, the
state and the flag reader's own ruleId (`license-feature-not-granted` /
`license-absent-feature-closed`), audited as a deny. `enforcementPointsWired` on the status API
now lists all four wired points.

**The ABSENT state is enforced per the posture table, which is a behaviour change stated
plainly.** With no license installed, `featureEnabled` closes every flag ("every tier feature is
**closed**" — the posture the 2026-08-02 amendment's table has stated from the start, and what
the status API has reported all along); these two creation routes now refuse on an unlicensed deployment
where they previously succeeded. Enforcing anything softer would have re-created the exact
reported-vs-enforced split this closure exists to remove. Contrast seats, which absence
deliberately leaves uncapped: there is no authoritative NUMBER to invent there, but "closed"
needs no invention. Grace keeps flags open and past-grace closes them, unchanged — `featureEnabled`
composes the expiry posture internally and is unit-tested for it. The gateway test suites that
legitimately exercise SAML/SCIM creation now run under a real ephemerally-signed license granting
exactly the flags they need (`testing/license-fixture.ts` — same ephemeral-keypair discipline as
`licensing.test.ts`, deployment left UNLICENSED after each suite).

**Proven, not asserted** (`licensing.test.ts`): a valid `team`-tier license WITHOUT the flags is
refused BY NAME at both points (403, feature + tier + ruleId, audited deny, nothing created); the
ABSENT state refuses with `license-absent-feature-closed` exactly as `features.*: false` has
always been reported; a tier WITH the flags creates both objects unchanged. Non-vacuity: removing
the one SAML flag read reddened exactly the two gating tests (21/23) and nothing else.

**Still unwired, named rather than implied:**

- **Flags with no reader yet**: `compliance_packs`, `advanced_orchestration`, `airgapped_mode`,
  `custom_model_providers` — reported-only today, exactly as all six were before this amendment.
- **Expansion points**: connector, MCP server, model-provider and PM/git connection creation
  still produce no license refusal (only `user.provision` and `agent.create` do).
- **`deploymentMode` stays recorded, not enforced.** Cross-checking a signed deployment grant
  against ADR-0027's A4 running-mode dimension decides what a mode-mismatched install DOES
  (refuse to boot? degrade? warn?) — that is its own decision with its own failure-posture
  argument, not a flag read, and it is deliberately not smuggled in here.
