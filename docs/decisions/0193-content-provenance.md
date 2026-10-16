# ADR-0193: Content provenance — native label and digest, in-toto/DSSE export, C2PA deferred

- **Status:** Accepted (owner, 2026-10-11)
- **Date:** 2026-10-11
- **Deciders:** owner. Answered in the master session on 2026-10-11: "go with your recommendations". The
  recommendations were those of research spike [R14](../research/R14-content-provenance-spike.md) (PR #329), §5.
- **Builds on:** ADR-0186 (signed decision receipts, RFC 3161 anchors), ADR-0189 (Decision BOM; owner decisions 1
  and 2 on in-toto/DSSE and key reuse), ADR-0176 (open source first), ADR-0180 (secure by default).

## Context

R14 found that nothing RegulAIt holds today proves anything about *content*. Receipts and the Decision BOM prove what
was decided and allowed; they record inputs only by digest and classification, and record outcomes without content
provenance. ROADMAP §7.3 calls content-trust detection "a detector, not a defense" until a source's trust is policy.
R14 compared native labels, in-toto/DSSE with Sigstore bundles, C2PA and W3C Verifiable Credentials, and recommended
Option B.

## Decision

1. **Option B is adopted.** The native provenance label and content digest are the authority. Our own code builds
   them at the gateway's interception point, because they are policy semantics (ADR-0176 §4). Each is bound into the
   audit chain and the receipt stream. An in-toto Statement v1 in a DSSE envelope is the standard export view. It may
   optionally be wrapped in a Sigstore bundle v0.3 with a public-key hint and our own RFC 3161 token, and verified
   offline with the maintained Apache-2.0 `@sigstore/*` packages. W3C Verifiable Credentials are not adopted.
2. **First slice: P0 and P1; signing after.** The first slice (I4) builds the label and digest (P0) and the trust-tier
   policy (P1), since P1 is what turns detection into a defense. Signing and export (P2, P3) follow in a later slice.
3. **Both byte sets are digested.** Both what upstream returned and what the gateway delivered after redaction or
   masking. When the content's classification is `pii`, the digest is keyed: an HMAC with a per-tenant key, so a
   low-entropy output cannot be correlated by digest. Otherwise it is a plain SHA-256.
4. **Timestamps reuse the anchor.** The anchor-level RFC 3161 token is carried as separate evidence, and each
   envelope is not timestamped separately. This adds no load on the timestamp authority. Per-envelope timestamps
   (the stock Sigstore check) can be added later if a customer needs them.
5. **One key.** Content signing reuses the ADR-0186 receipt key, with domain separation by a new `v` and the in-toto
   predicate type, as ADR-0189 owner decision 2 did. There is one key to rotate and protect.
6. **C2PA is deferred.** It is scheduled only when a customer asks for signed binary media or documents, or when the
   legal question below makes it mandatory. Plain text and JSON stay out of C2PA. A C2PA-listed CA certificate, needed
   for "trusted" on stock validators, is an owner spend item at that time.
7. **Three trust tiers: `trusted`, `standard`, `untrusted`.** An admin sets a source's tier, and the change is
   audited. Every source defaults to `untrusted` (ADR-0180). A compliance profile (the pillar 3 cascade) can force a
   minimum tier, and lowering a forced tier is refused.

## Open

- **EU AI Act Art. 50 machine-readable marking.** R5 lists these items as UNVERIFIED, because the primary text was
  unreachable from the session. This needs legal review. If a verified duty applies, decision 6 is revisited and C2PA,
  or another marking, becomes a requirement. This ADR makes no legal claim.
  - **Owner decision (accepted 2026-10-16): get counsel, no claims.** The owner chose this from the options the
    master session presented.
    - The owner obtains a legal opinion on the Art. 50 marking duty.
    - Until that opinion is in, the product, the docs and marketing text make **no** claim of Art. 50 compliance, and
      content marking stays optional.
    - If counsel says the duty applies, decision 6 is revisited and C2PA (or an equivalent marking) becomes a
      requirement.
    - The item stays open until the opinion arrives. No build follows from this decision.

## Consequences

- I4's first slice is policy work (labels, digests, tiers) with no new cryptographic dependency.
- The keyed digest needs per-tenant key management. It reuses the existing secret-encryption path, and the key never
  leaves the control plane.
- Export interoperability (in-toto, DSSE, Sigstore) comes in the second slice, through maintained Apache-2.0 packages,
  pinned and listed in `THIRD_PARTY.md`.
