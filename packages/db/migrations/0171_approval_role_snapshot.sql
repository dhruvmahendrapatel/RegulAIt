-- ADR-0186 A (Batch 4 review fix) — the approver role of a tool-call approval
-- is SNAPSHOTTED AT QUEUE TIME, like `quorum` and `signature_mode` (0170).
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785106000000.
-- It takes the number ADR-0187 had reserved for Batch 5, which moves to 0173
-- (journal `when` 1785108000000; 0172 is the Batch 4 review round 5 fix):
-- leaving a gap below an applied migration
-- would make a later 0171 silently never apply (CONTRIBUTING_PARALLEL_SESSIONS §4).
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
--> statement-breakpoint
-- ADR-0186 A (PR #198 review round 4): a fresh SSO login's `auth_time` is
-- compared at the precision the identity provider gives it. OIDC `auth_time`
-- is whole seconds, so a re-login in the same second as the request carries
-- the request's second; 0170's strict `auth_time > requested_at` refused that
-- (a CHECK violation where the gateway, `ssoAuthTimeFresh`, had accepted it).
-- A whole-second auth time may now equal the request's second; any other
-- auth time stays strictly after the request. Earlier seconds stay refused.
ALTER TABLE "sso_reauth_requests" DROP CONSTRAINT "sso_reauth_requests_verified_check";
--> statement-breakpoint
ALTER TABLE "sso_reauth_requests" ADD CONSTRAINT "sso_reauth_requests_verified_check" CHECK (
  "verified_at" IS NULL OR (
    "auth_time" IS NOT NULL AND (
      "auth_time" > "requested_at"
      OR (date_trunc('second', "auth_time") = "auth_time" AND "auth_time" >= date_trunc('second', "requested_at"))
    )
  )
);
