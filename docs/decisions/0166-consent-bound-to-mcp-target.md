# ADR-0166: An MCP Consent Is Bound to Its Target (Approval Context v3)

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0104 (payload binding), ADR-0105 (policy-context binding),
ADR-0043 (egress), ADR-0097 (MCP admission), ADR-0144 (approver review);
Codex finding AER-039
Migration: none

## Context

ADR-0104 bound an approval to its payload and ADR-0105 to the policy context
(matched rule versions, ABAC versions, required approver, scope). Neither bound
it to WHERE the call executes. An admin can edit an MCP server's `url` or
`allowPrivateRanges` in place — same id, same admitted inventory — and a consent
signed for upstream A was then consumed against upstream B. Egress validation
limits destinations; it does not make a different allowed destination the one
the approver reviewed (AER-039, reproduced: a URL change via API or SQL, a
posture change and manifest drift each let the old consent execute).

## Decision

1. The approval context digest (`regulait.approval-context.v3`) includes the
   call's **target**: server id, `url`, `allowPrivateRanges` and the admitted
   `admissionManifestDigest`. Changing any of them under the same server id is
   a new action target: the old consent goes stale (retired, re-queued) and the
   upstream is never contacted until a fresh consent is approved.
2. The proxy passes the target from the **same server row it connects with**, so
   the consent describes exactly the destination that receives the bytes;
   evaluation-only callers derive it from the current row.
3. Operational churn on the row — breaker counters, health cursors — is not in
   the target and does not invalidate a consent.
4. The queue's audit row records the bound target as host + posture + manifest
   digest (never the full URL, which can carry credentials).
5. The version bump makes every pre-v3 consent re-queue (fail-closed), the same
   contract as ADR-0105's.

## Tests

`packages/shared/src/approval-binding.test.ts` (each target field changes the
digest; the same target is the same consent); `apps/gateway/src/
zz-aer039-mcp-target-binding.test.ts` against two counting fake upstreams:
positive control; URL change via API (stale with zero contact on A and B, the
fresh consent executes on B only after approval, audit names B's host); URL
change via SQL; posture change; manifest drift; a barrier case where the URL
moves to B inside A's first request (the signed call still lands on A only, and
the next call needs a fresh consent); breaker churn keeps the consent.
Against the pre-fix code the four target-change cases fail. The ADR-0105 suite
and the ADR-0144 approver-review journeys still pass.
