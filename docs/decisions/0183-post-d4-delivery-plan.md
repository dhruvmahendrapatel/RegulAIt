# ADR-0183: Post-D4 delivery plan, and four owner decisions

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** owner
- **Builds on:** ADR-0175 (D1–D4, all merged), ADR-0176 (open source first), ADR-0177 (open-source projects and its
  open questions), ADR-0180 §1 (secure by default), ADR-0121 (Outlook send-only ChatOps), PathForward PF-04,
  ROADMAP §7.2 and §8.3, PENDING.md S4

## Context

The owner's ordered list is finished: ADR-0173 batches 2a–2c, ADR-0175 D1–D4 (PR #129, 3db120a) and the strict-defaults
batch (ADR-0181, PR #127). No next batch was defined. The pending work was spread over five overlapping lists:
STATE.md follow-ups, PENDING.md, ROADMAP §7.2 / §8.3 / §9, PathForward's waves, and ADR-0177 §4. The owner asked for a
review of the pending items, a priority order, and a delivery plan per feature.

The full plan, with scope, size, evidence and sequencing for each batch, is
[docs/product/DELIVERY_PLAN_2026-10-06.md](../product/DELIVERY_PLAN_2026-10-06.md). This ADR records the order and the
decisions taken with it.

## Decision

### 1. Batch order (owner confirmed, 2026-10-06)

1. **Batch 1: trust our own build** (PF-04, ROADMAP I8 and I5's CI half, PENDING S4's scanning half). Runs now.
2. **Batch 2: the debt tail.** `otpauth`, staleness in SQL, tailored refusal messages, Playwright sharding, the dev/CI
   object store, and the Outlook send half. Runs now, in parallel with batch 1 (no shared files).
3. **Batch 3:** memory retention that runs (I3), `/metrics` (G5), MCP protocol coverage and stdio/SSE transports (G3,
   G4), memory-store inventory and owners (I9).
4. **Batch 4:** dual control and step-up (I6); passkey-signed approvals, signed decision receipts and RFC 3161 anchor
   timestamps (ADR-0177 amendment items 1–3); the trace standards fix, vendored detection content and Sentinel-derived
   monitor rules (ADR-0177 §4 steps 1–3).
5. **Batch 5:** the sidecar engine contract (PF-23), then promptfoo, modelscan and garak, one PR each, then the Engines
   page.
6. **Batch 6** (structural; one at a time, each with its own ADR): per-agent and workload identity (I7, PF-02), Decision
   BOM and AI BOM (PF-09), isolation (PF-06), multi-tenancy (G10) only on a second customer, content provenance (I4).

The production set stays the owner's to schedule and is not in this order: HA (P2), any production designation (the
standing guardrail), attestation spend (P3), the third-party pen test, WAF/DDoS and HSM/FIPS, and real BYOC execution.

### 2. The S4 deferral on our own security scanning is lifted

The owner deferred SAST, dependency, secret and container scanning in CI on 2026-08-01 (PENDING S4, "D3"). That
deferral ends with batch 1. The third-party pen test, WAF/DDoS and HSM/FIPS remain deferred.

### 3. Dev/CI object store: SeaweedFS replaces the frozen MinIO image

MinIO's community images were removed in September 2026, and CI and the compose quickstart pin the frozen
`bitnamilegacy/minio:2025.7.23-debian-12-r5` image, which gets no CVE fixes. The owner first chose Garage. Before
recording that, its S3 compatibility reference was checked: Garage implements none of the Object Lock operations
(`PutObjectLockConfiguration`, `PutObjectRetention`, `PutObjectLegalHold` and their Get forms are all "Missing"). The
ADR-0060 real-bucket anchor tests prove behaviour against a COMPLIANCE-mode Object Lock bucket, so Garage cannot stand in.
The owner then chose **SeaweedFS** (Apache-2.0), whose S3 API documentation lists Object Lock configuration, retention
and legal hold as supported.

The switch is conditional on proof: batch 2 runs the ADR-0060 "proof by attack against a REAL Object-Lock bucket" suite
against SeaweedFS first. If any of it fails, the MinIO pin stays and the gap is reported, not papered over. This is a
dev/CI stand-in only; a customer install still anchors to AWS S3 or its own Object Lock store (ADR-0060).

### 4. Vendored detection patterns on the audit path: redact on match

This answers ADR-0177 open question 3. Patterns vendored from pipelock, NeMo's YARA rules and the agent governance
toolkit behave like today's credential scrub (ADR-0102): the match is replaced by a marker and the event is audited.
There is no review queue. A false positive costs a redacted word; a missed secret would be stored. ADR-0177 §4 step 2
can start when batch 4 is reached.

### 5. Outlook ChatOps: build the send half that ADR-0121 designed

ADR-0121 made Outlook a send-only provider, because email cannot authenticate an inbound decision. Inbound stays refused
by design. The send half was never built, so registering an Outlook workspace has been refused with 422
`outbound_provider_unavailable` since the AER-015 fix. Batch 2 builds the courier: a Microsoft Graph `sendMail` message
carrying the approval request and a link to the portal. The decision is still taken only in the portal, never by reply.
It needs a governed `Mail.Send` credential and the Graph host on the egress allow-list. Once the sender exists,
`CHATOPS_OUTBOUND_PROVIDERS` includes `outlook`, and registration opens without any other change.

## Consequences

- Batches 1 and 2 run as parallel branches and one PR each. Batches 3 to 5 are serial, because they share `schema.ts`,
  the migration journal, `app.ts` and `mcp-proxy.ts`. The next migration is 0169; batch 1's own ADR takes 0184.
- Every batch keeps the standing rules: a red-proof test per rule, every new setting strict and its relaxation audited,
  a security review before merge, and a merge commit with the full head SHA.
- ADR-0177's other two open questions are still open: fickling (LGPL-3.0), and whether offensive tooling stays
  import-only. Neither blocks batches 1 to 4.
