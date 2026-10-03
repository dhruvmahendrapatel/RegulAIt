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
   digest (never the full URL, which can carry credentials). The approver sees
   exactly that: `GET /v1/approvals` (the Inbox, Review Workbench and Approvals
   page) carries `boundTarget` on every MCP row, read back from the audit row
   that holds the consent's own context digest — never from the server's current
   row — and the review dialog shows it as "Target: host · private ranges … ·
   manifest 1a2b3c4d". No such row (a pre-v3 consent) reads "Not recorded". The
   review key includes it, so a review does not carry across a changed target.
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

Added with the review surface (same file): the URL-via-API case now also
asserts the fresh review names B's host before anyone signs it, while the retired
one still names A; a **posture change through the API** (`PATCH /v1/servers/:id`,
inherit → allowed) leaves the consent unspent with zero contact, the fresh review
carries the new posture, and once approved it executes on A exactly once;
**schema drift through a real manifest resync** (mode `log`; the caller lists
tools through the proxy, which runs `syncUpstreamTools` → `recordManifestScan`)
— resyncing the unchanged manifest keeps the digest and the consent still
matches, then the upstream's input schema gains a property, the resync records a
new digest, the old consent is refused with zero contact and the fresh review
names the new digest; a **`lastHealthProbeAt`-only update** keeps the consent;
and the **review row names the bound target, not the live one** — after the
server is re-pointed at B through a URL carrying a query-string credential, the
signed row still names A, the re-queued row names B's host only, and the
credential appears nowhere in the response. Negative controls: dropping the
target from the digest fails the API-posture and resync cases; reading the
target from the server's live row fails the review and URL-via-API cases;
binding `lastHealthProbeAt` fails the health-probe case; removing the
enrichment fails every review assertion. `apps/web/src/views/approvals/
approvalReview.test.ts` covers the rendered line (posture words, short digest,
"Not recorded", a credential-bearing value never rendered) and the review key;
`apps/web/e2e/mcp-action-review.spec.ts` asserts the real dialog shows the
upstream's host on the Target line (and fails with the line removed).

## Residuals

- The admitted-manifest digest is ADR-0097's 64-bit FNV-1a change detector,
  not a collision-resistant hash: an upstream that can craft a colliding
  manifest changes its schema without moving the consent. Replacing it is out
  of scope here.
- `allowPrivateRanges = NULL` binds "inherit the org default", not the
  effective posture; `org_settings.mcpPrivateRangesDefault` is not in the
  digest, so by source reading a change to the default alone does not move
  the target (not exercised by a test).
