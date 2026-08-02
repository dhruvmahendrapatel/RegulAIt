# ADR-0052 — Licensing & seats: a signed offline license, seat caps, tier flags, and a split-by-action-class expiry posture

- **Status**: Proposed
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
