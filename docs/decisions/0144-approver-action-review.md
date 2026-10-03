# ADR-0144: Approver Action Review

Status: Accepted (implemented; public redaction remains gated)
Date: 2026-09-30

## Decision

Reserve migration 0121 and the approval UI/presentation surfaces. Record the
preview format and consent scope explicitly when MCP approvals are queued.
Do not infer redaction from caller-controlled payload keys. Preserve the
project attribution on the approval row. Existing records remain unknown;
the migration must not invent provenance, scope or attribution.

Use one action-review component in the personal inbox, admin queue and bulk
triage. Show the effective arguments for a redacted action, the recorded
arguments otherwise, and clearly disclose credential masking, scope,
expiry, policy/schema fingerprints and transformation versions. Plain text
rendering must not execute payload markup. Missing or malformed review data
cannot be approved through this UI; denial remains available.

Single MCP approvals are decided from the review dialog. Bulk approval
requires a review keyed to each selected MCP row's current binding. This is
an operator workflow safeguard, not a claim to enforce human attention or
to replace server authorization, exact-action matching and atomic consume.
Other approval kinds retain their existing workflows.

Verify real queue/API metadata, scope and attribution, all three browser
surfaces, malformed/legacy states, safe rendering, and desktop/mobile layout.
This does not enable public redaction or close the other ADR-0137/0143 gates.

## Verification

Migration 0121 records format and scope without backfilling unknown historical
facts. MCP issuance now retains project attribution, and its pending lookup
does not reuse a legacy row without review metadata. Queue labels are enriched
after the existing visibility checks.

85 focused tests passed: 25 review-parser/binding cases, 23 real MCP/database
cases, 10 approval-binding cases and 27 workbench authorization/routing cases.
The sensitive-project case uses a named approver and verifies the per-item
bulk refusal; bootstrap identities cannot decide at all.

Five real Chromium journeys passed against a fresh scratch database: effective
payload review -> UI approval -> actual MCP execution; legacy/malformed/expired
Inbox denial; raw payload keys that impersonate transformation metadata; bulk
re-review after a changed binding; and existing server-side queue filtering.
The changed-policy case cannot execute even after its UI approval. Desktop
and 390px mobile screenshots were inspected; payload markup stays literal,
credentials stay masked, long values wrap, decisions remain accessible, and
Tab/Escape focus behavior is asserted. DB/gateway builds and web typecheck/build
passed. The existing large-bundle warning remains unrelated and unresolved.

The review mark is local UI state, not a server assertion that a human read
the payload. Direct API decisions continue to rely on server authorization,
policy binding and atomic consumption. Historical unknown previews require a
fresh request in these screens, not fabricated metadata. Public redaction,
model/connector preparation and final output-policy gates remain open.
