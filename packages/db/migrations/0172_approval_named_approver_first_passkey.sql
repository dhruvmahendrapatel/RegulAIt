-- ADR-0186 A (PR #198 review round 5). Hand-written (never drizzle-kit
-- generate); journal `when` 1785107000000. Batch 5 (ADR-0187) moves to 0173
-- (`when` 1785108000000).
--
-- 1. `approvals.named_approver_user_id` — the approver NAMED when a tool-call
--    approval was queued, persisted. Until now it was reconstructed from
--    `approval-routed` / `approval-claimed` audit rows, which the retention
--    prune may delete (a 1-day audit floor is allowed against a 72-hour
--    approval TTL): a prune could change who may decide, or strand the row.
--    Eligibility, the execution recheck and queue visibility read this column.
--    BACKFILL: pending and approved tool-call approvals take the same
--    reconstruction the gateway used until now (no assignment -> the stored
--    approver; else the approver the first routing/claim audit row moved away
--    from; else an assignment with no routing rule -> its assignee; else nobody).
--    Decided rows are history and stay NULL.
ALTER TABLE "approvals" ADD COLUMN "named_approver_user_id" uuid;
--> statement-breakpoint
UPDATE "approvals" a SET "named_approver_user_id" = (CASE
    WHEN NOT EXISTS (SELECT 1 FROM approval_assignments aa WHERE aa.approval_id = a.id)
      THEN a.approver_user_id
    WHEN EXISTS (SELECT 1 FROM audit_log l
                 WHERE l.rule_id IN ('approval-routed', 'approval-claimed') AND l.detail->>'approvalId' = a.id::text)
      THEN (SELECT CASE WHEN l.detail->>'previousApproverUserId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (l.detail->>'previousApproverUserId')::uuid END
              FROM audit_log l
              WHERE l.rule_id IN ('approval-routed', 'approval-claimed') AND l.detail->>'approvalId' = a.id::text
              ORDER BY l.seq LIMIT 1)
    ELSE (SELECT CASE WHEN aa.rule_id IS NULL THEN aa.assignee_id END FROM approval_assignments aa WHERE aa.approval_id = a.id)
  END)
  WHERE a.status IN ('pending', 'approved') AND a.object_type IN ('mcp_tool', 'connector_call');
--> statement-breakpoint
-- 2. `webauthn_challenges.first_passkey` — a registration ceremony admitted by
--    the first-passkey rule (no way to step up yet, a fresh human sign-in)
--    rather than by a `passkey_manage` step-up. Its completion re-checks, under
--    the user's row lock, that the account still has no way to step up, so two
--    concurrent "first" enrolments cannot both skip the step-up. Only a
--    register ceremony can carry it.
ALTER TABLE "webauthn_challenges" ADD COLUMN "first_passkey" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_first_passkey_check" CHECK (NOT "first_passkey" OR "purpose" = 'register');
--> statement-breakpoint
-- 3. `approval_delegations` joins the policy-epoch sources (0119/0120/0122):
--    the execution recheck reads the live delegation graph (who is one
--    principal, who is linked to the caller), so a delegation write advances
--    the epoch an in-flight consumption holds FOR SHARE and a consent evaluated
--    before it is re-evaluated, never spent across it.
create trigger approval_delegations_policy_epoch
  after insert or update or delete on approval_delegations
  for each statement execute function advance_governance_policy_epoch();
