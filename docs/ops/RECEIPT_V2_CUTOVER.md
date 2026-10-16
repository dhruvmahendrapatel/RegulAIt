# Receipt v2 cutover: drain old replicas first — runbook (NOT YET EXECUTABLE)

**For the operator of a multi-replica deployment.** ADR-0189 amendment R43 makes the drain of old replicas before
the receipt v2 cutover "a runbook step (B8)". This file is that step's home.

> **Status, 2026-10-16 (commit `6b35301`): no cutover or drain step in this file has been executed, and none has a
> command.** The one command here is an offline verification of a specification vector, executed as shown. The
> receipt v2 cutover itself is not built: `RECEIPT_EMITTER_SUPPORTS_V2` is `false`
> (`packages/shared/src/batch4.ts`), no operation records a receipt v2 boundary, and every receipt is v1. A cutover
> needs Postgres and a running multi-replica stack, neither of which was available. Under M-041 no command is written
> here until it has been run. The cutover slice that flips the switch must replace this status box with executed
> commands and their real output, and must run every step below on a staging stack first.

## Why the drain matters

From the cutover on, a receipt for an audit row at or above the boundary (`from_audit_seq`, R42) must be v2, with the
decision's `factsHash` (R34). A v1 receipt at or above it is `invalid` (`v1_receipt_after_boundary`; see below). A
replica still running a build that cannot emit v2 would write exactly such receipts. The design
closes this three ways (R43):

1. **The drain (this runbook):** the cutover runs only after a rolling deploy in which every replica runs v2-aware
   code (B2 or later) and the old replicas have been drained, not left serving.
2. **A boot refusal:** every binary from B1 on checks at boot and refuses to start when a receipt v2 boundary exists
   and it cannot emit v2 receipts with facts (`assertReceiptEmitterBootable`, `apps/gateway/src/decision-receipts.ts`,
   called from `apps/gateway/src/boot.ts` before the server listens).
3. **The sign lock:** every receipt writer reads the boundary under the receipt sign lock before each pass, so a v1
   receipt can never land at or above `from_audit_seq`.

A binary older than B1 has no boot check at all, which is why the drain is a required step and not a formality.
There is no replica heartbeat or registry to confirm it automatically (R43 replaced that with this procedure).

The receipt v2 cutover may be one operation with the ADR-0188 audit v2 cutover (ADR-0189 open question 1). That
audit cutover is built (ADR-0188 decision 19, slice S4: `apps/gateway/src/audit-v2-cutover.ts`) and needs the same
drained rollout; its own procedure belongs to ADR-0188.

### What an auditor sees if a stray v1 receipt lands after the boundary

Vector N-R12 (`packages/shared/test-vectors/decision-bom/b4-vectors.json`) is that case: a v1 receipt for audit seq
42 with the boundary at 42. Run from the root of a built checkout with `WORK` set as in
[BOM_VERIFICATION.md](BOM_VERIFICATION.md) Part A (executed offline, inside `unshare --net`):

```bash
# where: air-gapped
node scripts/bom-vector-bundle.mjs N-R12 "$WORK/selftest/N-R12"
node scripts/verify-bom.mjs "$WORK/selftest/N-R12/regulait-export-decision-bom-a0000000-0000-4000-8000-000000000042-v1.tar.gz" \
  --keyring "$WORK/selftest/N-R12/trust/export-keyring" \
  --receipt-keyring "$WORK/selftest/N-R12/trust/receipt-keyring.json" --now 2026-10-11T00:00:00.000Z
echo "exit code: $?"
```

```text
vector N-R12 (negative, decision-bom): v1 receipt at a seq at or above the known boundary (boundary 42, seq 42)
…
expected outcome: invalid
…
    Decision BOM b0000000-0000-4000-8000-000000000001 v1 of decision a0000000-0000-4000-8000-000000000042; finality chain_signed (reported chain_signed); receipt v1
    …
    [valid] receipt_signature
    [valid] receipt_payload_hash
    [invalid] receipt_facts_binding: v1_receipt_after_boundary
    …
    OUTCOME: INVALID

exit code: 1
```

The receipt is correctly signed; it is still not evidence, because it is the wrong version for its position. That is
the failure an undrained replica would produce.

## The procedure, as required (pending execution)

Each step states what must be true. The commands depend on how the deployment runs its replicas (compose, Kubernetes,
a BYOC orchestrator) and are written by the cutover slice once executed.

1. **Prerequisites merged and deployed:** ADR-0189 B2 (fact capture) and ADR-0188 S4 (the actor columns the v2
   payload reads). The audit v2 cutover has run, or runs in the same operation: a v2 receipt refuses an audit v1 row.
2. **Roll every replica to a v2-aware build.** Record each replica's image digest and confirm all are the same
   v2-aware build.
3. **Drain the old replicas.** No replica of an older build may remain serving, scheduled, or able to restart: remove
   it from the load balancer, stop it, and remove its definition, so an orchestrator cannot bring it back. Include
   batch and worker processes that sign receipts, not only the HTTP replicas.
4. **Confirm the drain** against the orchestrator's own record of running workloads, not a health page that a stale
   replica could still answer.
5. **Run the cutover once**, from one replica. It records the boundary under the audit append lock and the receipt
   sign lock (R42).
6. **Verify after the cutover:** a decision made after it has a v2 receipt; a Decision BOM for that decision verifies
   offline with `receipt v2` and `receipt_facts_binding` `valid`, using the receipt keyring from
   `GET /v1/receipts/export` (which carries `receiptV2FromAuditSeq`), as in
   [BOM_VERIFICATION.md](BOM_VERIFICATION.md) Part B.
7. **Prove the boot refusal on staging:** a build that cannot emit v2 refuses to start against the cut-over database
   (R43). Do this on a staging copy, never in a live deployment.
8. **Give auditors the new keyring file**, so their offline trust root carries the boundary.

## Pending

Every step of the procedure above. The boot refusal is covered by the gateway's database tests
(`apps/gateway/src/zz-adr0189-b1-foundation.test.ts`, `zz-adr0189-b2-facts.test.ts`), which run in CI against Postgres;
they were not run in this session, which has no Postgres.
