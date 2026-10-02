-- ADR-0159 — remediation proposals for governance-monitor alerts.
--
-- Only EXECUTABLE proposals are stored (guidance is computed on read). Each is
-- bound to one approvals row; the decide path executes it inside the decision
-- transaction. The proposal records exactly what will run (kind + params) so
-- the approver signs a specific action, not a description of one.
CREATE TABLE IF NOT EXISTS "remediation_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id" uuid REFERENCES "governance_alerts"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "params" jsonb NOT NULL,
  "title" text NOT NULL,
  "rationale" text NOT NULL,
  "status" text DEFAULT 'pending_approval' NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "proposed_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "remediation_proposals_kind_check" CHECK ("kind" IN ('link_control', 'assign_agent_owner')),
  CONSTRAINT "remediation_proposals_status_check"
    CHECK ("status" IN ('pending_approval', 'applied', 'denied', 'failed')),
  CONSTRAINT "remediation_proposals_decided_check"
    CHECK (("status" = 'pending_approval') = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remediation_proposals_approval_uq"
  ON "remediation_proposals" ("approval_id") WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
-- one pending proposal per identical action: re-proposing returns the open one
CREATE UNIQUE INDEX IF NOT EXISTS "remediation_proposals_pending_action_uq"
  ON "remediation_proposals" ("kind", "params") WHERE "status" = 'pending_approval';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remediation_proposals_alert_idx" ON "remediation_proposals" ("alert_id");
