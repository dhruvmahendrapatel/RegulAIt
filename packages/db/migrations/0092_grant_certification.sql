-- Migration 0092 (ADR-0090) — GRANT CERTIFICATION CAMPAIGNS (gap L22,
-- docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
--
-- Saviynt's core loop is the certification campaign: periodic, owner-driven
-- review of entitlements with attest/revoke decisions. Ours is scoped
-- DELIBERATELY to gateway grants only — the entitlement rows THIS gateway
-- enforces (agent/connector/MCP tool/server grants, direct and role-bundled).
-- A fabric-wide campaign over other systems' entitlements is IGA's job, not
-- ours; we integrate with IGA, we do not compete with it.
--
-- THE RULES THIS SCHEMA STATES (enforced in the gateway):
--
--   * Items are SNAPSHOTS taken at campaign open. A campaign reviews the
--     grants that existed when it opened; a grant created afterwards is out
--     of its scope — recorded fact, never an implied "continuous coverage".
--     The holder/object labels are copied at open so the item stays readable
--     even after the underlying row is revoked or renamed.
--   * Decisions ride the ONE approvals queue: every item carries an
--     `approval_id` into the one `approvals` table, and keep/revoke land
--     through the one decide path with its named-reviewer, delegation,
--     admin-override and audit machinery — never a second decision endpoint.
--   * `decision` is NULLABLE ON PURPOSE and stays null forever if nobody
--     decides. There is no auto-keep and no auto-revoke on expiry: a
--     past-due campaign with undecided items reads `expired-incomplete`
--     (computed at read time — no scheduler writes it) and that posture fact
--     is the product's answer, not a silent timeout decision.
--   * A stored campaign status is only ever 'open' or 'completed'
--     ('completed' written when the last item is decided, inside the
--     decision's own transaction). 'expired-incomplete' is a READ-TIME
--     projection of open + past-due + undecided, so it can never be stale
--     and nothing needs to fire for it to be true.

CREATE TABLE IF NOT EXISTS "grant_certification_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- what the campaign reviews: every gateway grant, the grants on agents in
  -- a lifecycle state, the grants on one owner's agents, or one user's
  -- direct grants. A closed vocabulary — there is no scope that reaches
  -- outside this gateway's own grant tables.
  "scope_kind" text NOT NULL,
  -- lifecycle status / owner user id / holder user id, per scope_kind
  "scope_value" text,
  "opened_by_user_id" uuid NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "grant_cert_campaigns_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "grant_cert_campaigns_scope_kind_check"
    CHECK ("scope_kind" IN ('all', 'agent_lifecycle', 'agent_owner', 'user')),
  -- 'all' carries no value; every narrowed scope carries one
  CONSTRAINT "grant_cert_campaigns_scope_value_check"
    CHECK (("scope_kind" = 'all') = ("scope_value" IS NULL)),
  CONSTRAINT "grant_cert_campaigns_status_check" CHECK ("status" IN ('open', 'completed')),
  CONSTRAINT "grant_cert_campaigns_completed_check"
    CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL))
);

DO $$ BEGIN
  ALTER TABLE "grant_certification_campaigns"
    ADD CONSTRAINT "grant_cert_campaigns_opened_by_fk"
    FOREIGN KEY ("opened_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "grant_certification_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  -- which grant table the snapshot came from (direct and role-bundled kinds)
  "grant_kind" text NOT NULL,
  -- the grant ROW id at open — the thing a revoke decision deletes. Not an
  -- FK: the row may legitimately disappear (revoked here, or deleted through
  -- the ordinary admin endpoints between open and decide) and the item must
  -- survive as the record of what was reviewed.
  "grant_id" uuid NOT NULL,
  -- exactly one of holder_user_id (direct kinds) / holder_role_id (role
  -- kinds) — who enjoys the grant
  "holder_user_id" uuid,
  "holder_role_id" uuid,
  "holder_label" text NOT NULL,
  -- the granted object (agent/connector/server id) + display label; tool
  -- kinds also carry the tool name
  "object_id" uuid,
  "object_label" text NOT NULL,
  "tool_name" text,
  -- the named reviewer this item was routed to at open (agent owner where
  -- one exists, else the campaign opener)
  "reviewer_user_id" uuid NOT NULL,
  -- the row in the ONE approvals queue that carries this item's decision
  "approval_id" uuid,
  -- keep|revoke, written only by the one decide path; NULL forever if nobody
  -- decides (no auto-decision on expiry, ever)
  "decision" text,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  -- what executing a revoke actually did (mechanism + whether the row was
  -- still there) — the evidence half of "revocation is enforced, not exported"
  "revocation_detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "grant_cert_items_kind_check"
    CHECK ("grant_kind" IN ('agent', 'connector', 'tool', 'server',
                            'role_agent', 'role_connector', 'role_tool', 'role_server')),
  CONSTRAINT "grant_cert_items_holder_check"
    CHECK (("holder_user_id" IS NULL) <> ("holder_role_id" IS NULL)),
  CONSTRAINT "grant_cert_items_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('keep', 'revoke')),
  -- a decision always carries who and when; an undecided item carries neither
  CONSTRAINT "grant_cert_items_decided_check"
    CHECK (("decision" IS NULL) = ("decided_at" IS NULL)),
  CONSTRAINT "grant_cert_items_decided_by_check"
    CHECK (("decision" IS NULL) = ("decided_by_user_id" IS NULL))
);

DO $$ BEGIN
  ALTER TABLE "grant_certification_items"
    ADD CONSTRAINT "grant_cert_items_campaign_fk"
    FOREIGN KEY ("campaign_id") REFERENCES "grant_certification_campaigns"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL, not CASCADE: approvals rows cascade away with their user; the
-- certification item is the durable record of the review and must outlive
-- the queue row that carried it.
DO $$ BEGIN
  ALTER TABLE "grant_certification_items"
    ADD CONSTRAINT "grant_cert_items_approval_fk"
    FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "grant_cert_items_campaign_idx"
  ON "grant_certification_items" ("campaign_id");
CREATE INDEX IF NOT EXISTS "grant_cert_items_approval_idx"
  ON "grant_certification_items" ("approval_id");
CREATE INDEX IF NOT EXISTS "grant_cert_items_reviewer_idx"
  ON "grant_certification_items" ("reviewer_user_id");
CREATE INDEX IF NOT EXISTS "grant_cert_campaigns_status_idx"
  ON "grant_certification_campaigns" ("status");
