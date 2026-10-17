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

## As built — 2026-10-17: I4 first slice, P0 and P1 (migration 0206)

Built on branch `content-provenance-p0p1`. This section records how decisions 1 to 4 and 7 were built and where the
build stops short of them. The owner text above is unchanged. Nothing here claims EU AI Act Art. 50 compliance or any
other legal content-marking duty (Open, owner decision of 2026-10-16); the admin page says so in its help text.

**Open source first (ADR-0176).** No library was added. The digests are SHA-256 and HMAC-SHA-256 from Node's
`node:crypto`, and the canonical bytes are the audit chain's existing canonical JSON (`canonicalJson`, the
serialisation receipts already sign). The label, the tiers and the write rule are policy semantics, which ADR-0176 §4
keeps as our own code; R14 §1.4 found no library that provides them. The `@sigstore/*` packages belong to the P3
export slice and are not installed yet.

### P0: the label and the digests (decisions 1, 3 and 4)

- **Where.** At two governed return paths: the MCP tool result (`executeGovernedToolCall`, so the proxy route, the
  orchestration worker loop and the builder all pass through it) and the connector result
  (`executeGovernedConnectorCall`). Each records its evidence *before* it delivers anything, and a failure to record
  throws, so no unrecorded result leaves the gateway. On the connector path the evidence is written in the existing
  output-evidence transaction.
- **Not yet covered:** model output (`dispatchAttempt`, the compat surfaces) and retrieved shared context
  (`resolveSuppliedContext`). R14 §4 P0 lists both. They are follow-ups for the next slice. Streaming digests over the
  full stream at close belong with model output.
- **Both byte sets (decision 3).** `upstream` is what the upstream returned. `delivered` is what the caller receives
  after redaction, masking or a withheld marker. A string is digested as its UTF-8 bytes. Anything else (an MCP
  `CallToolResult`, a connector JSON body) is digested as the audit chain's canonical JSON, so key order does not
  matter. The label records which form was used (`bytes`) and whether the two differ (`transformed`).
- **Keyed digest for `pii` (decision 3).** The classification is `pii` when the PII scan found PII or withheld the
  result for it, `clean` when a scan ran and found none, and `unscanned` when none ran. `unscanned` covers an
  unattributed call, which has no PII mode, and encoded content the scanner could not read. Only `clean` gets a plain
  SHA-256. `pii` and `unscanned` get an HMAC-SHA-256 under the per-tenant key, because the strict reading of "pii"
  (ADR-0180) is "not shown to be free of PII".
  - The key lives in `content_digest_keys`. It is 32 random bytes, stored as a data-key envelope and made on first
    use, as ADR-0195's pseudonym key is. It is registered in `CIPHERTEXT_COLUMNS`, so data-key rotation re-encrypts it
    and does not change any digest.
  - The record names the key's row id. The key never leaves the control plane.
  - When no data key is configured, a keyed digest cannot be made. The digest is then `unavailable` and no digest is
    stored at all, never an unkeyed digest of content that may be PII. A database CHECK enforces the pairing of
    algorithm and classification.
- **Evidence formats (decisions 1 and 4).** Each result writes two rows in one transaction:
  - an audit row (`object_type = content_provenance`, rule `content-provenance`) whose `detail.contentProvenance` is
    the label `regulait.content-provenance-label.v1`. The row's content hash covers the label, so the existing chain,
    the WORM anchors and the anchors' RFC 3161 tokens cover it, and no new crypto is involved;
  - a `content_provenance_records` row naming that audit row and the decision audit row that allowed the call (whose
    receipt covers the decision). It holds digests only, never content. It is append-only: UPDATE and DELETE are
    refused by a guard whose function pins `search_path`, and TRUNCATE is refused (the 0185 invariants).
- **Timestamp evidence (decision 4).** `GET /v1/content-provenance/records` returns, for each record, the first audit
  anchor whose `seq` is at or past the provenance audit row's, with that anchor's `tsa_status` and `tsa_gen_time`. No
  envelope is timestamped on its own.
- **The receipt stream (decision 1), deviation.** The label is bound to the decision receipt by reference
  (`decisionAuditId`). It is not yet signed into the receipt stream. The available carrier is
  `decision_fact_addenda`, whose rows the receipt sweep signs, but it needs a `decision_facts` row (absent when capture
  is off), it has a fixed addendum schema, and it is part of the Decision BOM's verified bytes. Signing the label with
  the receipt key under a new `v` is P2 (decision 2), so it is left to that slice.

### P1: the trust-tier policy (decision 7)

- **Tiers.** There are three: `untrusted`, `standard` and `trusted`. A tier is set per source, an MCP server or a
  connector, in `content_trust_tiers`. A source with no row is `untrusted` (ADR-0180).
- **The rule (R14 §4 P1, ROADMAP I4).** A WRITE is refused when its causal context already holds content whose tier is
  below the write floor. A read is never refused.
  - The write floor is `content_trust_settings.write_floor`. It is `trusted` by default, so untrusted and standard
    content cannot drive a write. `standard` is the one relaxation. `untrusted` is not a valid floor, so the policy
    cannot be switched off.
  - In each context, a source's tier is the lower of its tier when the content was observed and its current tier. So
    demoting a source takes effect at once for content already in a run, and promoting one does not raise content
    already observed.
  - A refusal is a decision-class audit row: rule `content-trust-floor`, code `content_trust_refused`, with the
    context, the lowest tier and the floor. The gate sits beside the ADR-0023 `mcpDefaultMode` gate: after the
    entitlement decision, and before the budget gate, the approval queue, the credential and the upstream. A refused
    write executes nothing and bills nothing, and it beats approval (no approver can sign away where the instruction
    came from).
- **Causal context.** This slice tracks two contexts:
  - an orchestration run (`run:<id>`, passed by the worker loop);
  - a builder thread (`builder_thread:<id>`, passed by the builder runtime for both MCP tools and connectors).

  Each result is recorded under its context, and each write in that context is checked against it. The direct MCP
  proxy route and the direct connector invoke route carry no context the gateway can see: their results are recorded
  (P0) with `context_id` NULL and are not gated. Gating them needs a client-declared context or a session model. That
  is a follow-up, as is the instruction-hierarchy boundary (ROADMAP I4, second half).
- **Changing a tier is an audited step-up.**
  - Every change, up or down, needs a `settings_relax` step-up: `PUT /v1/content-trust/sources/:sourceKind/:sourceId`.
    The ADR says "an admin sets a source's tier, and the change is audited", so no new step-up kind was added and the
    0203 CHECKs are untouched.
  - Changing the write floor needs one too: `PUT /v1/content-trust/settings`.
  - Each write is a compare-and-set on the value the step-up decision rested on (`409 changed_concurrently`).
  - Each is audited (`content-trust-tier-set`, `content-trust-floor-set`), with `relaxation: true` when it loosens.
- **Not built in this slice:** "a compliance profile can force a minimum tier, and lowering a forced tier is refused".
  Sources are not project-scoped today, so a profile floor needs a decision on how a profile reaches a server or
  connector (through the projects that call it, or a per-profile source list). It is an open question for the owner,
  below.

### Admin UI

`/admin/content-trust` (Governance, beside Guardrails) has three cards:

- the write floor;
- every source with its tier (marked "(default)" while unset) and a per-row tier control;
- the newest 50 provenance records, showing digests and covering anchors and never content.

Every change goes through the step-up dialog. The route census reports `KNOWN_UI_GAPS` 0. The ADR-0196 enterprise
harness runs axe, perf, responsive and states on the new route with no baseline entries.

### Migration 0206 (`0206_content_provenance.sql`)

- Tables: `content_digest_keys` (one row), `content_trust_tiers`, `content_trust_settings` (one row, seeded `trusted`)
  and `content_provenance_records` (append-only, with its guard function and TRUNCATE refusal).
- It is hand-written. Its journal entry is added by the master session after 0204 and 0205.

### Open questions for the owner

1. **The compliance-profile minimum tier (decision 7).** Does a profile reach a source through the projects that call
   it, or through a per-profile list of sources?
2. **The direct proxy and connector routes.** Should a client be able to declare a causal context (a header) so that
   external agents are gated too, and should declaring one be mandatory under a strict setting?
3. **`standard` versus approval.** Under the default floor, standard content is refused like untrusted content. Should
   a write after standard content instead require an approval?
