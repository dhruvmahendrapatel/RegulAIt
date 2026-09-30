# ADR-0144: Approver Action Review

Status: Accepted (implementation in progress)
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
