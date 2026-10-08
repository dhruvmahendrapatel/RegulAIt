-- ADR-0186 A (Batch 4 review fix) — the approver role of a tool-call approval
-- is SNAPSHOTTED AT QUEUE TIME, like `quorum` and `signature_mode` (0170).
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785107000000.
-- 0171 (journal `when` 1785106000000) is reserved for Batch 5 by ADR-0187 and
-- is deliberately not taken here.
--
-- `approvals.approver_role_id`: the approver role of the rule that named the
-- approver when the call was queued. Eligibility (decide, signing-options, the
-- execution recheck) and queue visibility read it, never the rule's current
-- role, so a rule edit, a version change or a role swap while the approval is
-- pending neither drops the members who were eligible nor admits new ones. No
-- foreign key: it is a historical fact; a deleted role's assignments go with
-- it, which only narrows the pool.
--
-- Existing PENDING tool-call approvals take their rule's role as it stands
-- now (the role they are judged against today); decided rows are history and
-- are left alone.
ALTER TABLE "approvals" ADD COLUMN "approver_role_id" uuid;
--> statement-breakpoint
UPDATE "approvals" a SET "approver_role_id" = r."approver_role_id"
  FROM "approval_rules" r
  WHERE r."id" = a."rule_id" AND a."status" = 'pending' AND a."object_type" IN ('mcp_tool', 'connector_call');
