-- ADR-0337 §5 (lane E18, slice 3b): a SaaS entitlement finding raised into the approvals queue for a second
-- administrator's recorded decision. Hand-authored (never drizzle-kit generate); additive and idempotent.
--
--   saas_finding_reviews  one row per raised finding: its key, rule and version, its subject (a grant or a registry
--                         record, SET NULL when the vendor side removes it), the rationale and evidence as raised (a
--                         deliberate point-in-time copy the approval digest binds), and its status, an ADR-0348 machine
--                         (pending -> remediate | accepted | withdrawn). At most one pending review per finding.
--
-- Nothing executes on a decision: RegulAIt never revokes a vendor-side grant. Row-level security, ENABLED and FORCED:
-- an active admin principal and the `system_task` and `migration` reasons only. No functions or triggers.

CREATE TABLE IF NOT EXISTS "saas_finding_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "finding_key" text NOT NULL,
  "rule_id" text NOT NULL,
  "rule_version" integer NOT NULL,
  "grant_id" uuid REFERENCES "saas_entitlement_grants"("id") ON DELETE SET NULL,
  "agent_record_id" uuid REFERENCES "agent_registry_records"("id") ON DELETE SET NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "rationale" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE RESTRICT,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "saas_finding_reviews_status_check" CHECK ("status" IN ('pending', 'remediate', 'accepted', 'withdrawn')),
  CONSTRAINT "saas_finding_reviews_rule_check" CHECK ("rule_id" IN ('unused-grant', 'excessive-scope', 'oversharing', 'publicly-exposed-agent')),
  CONSTRAINT "saas_finding_reviews_key_check" CHECK ("finding_key" ~ '^[a-z-]{1,40}:(grant|record):[0-9a-f-]{36}$'),
  CONSTRAINT "saas_finding_reviews_subject_check" CHECK ("grant_id" IS NULL OR "agent_record_id" IS NULL),
  CONSTRAINT "saas_finding_reviews_reason_check" CHECK (length("reason") BETWEEN 1 AND 1000),
  CONSTRAINT "saas_finding_reviews_rationale_check" CHECK (length("rationale") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saas_finding_reviews_pending_uq" ON "saas_finding_reviews" ("finding_key") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saas_finding_reviews_approval_uq" ON "saas_finding_reviews" ("approval_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_finding_reviews_key_idx" ON "saas_finding_reviews" ("finding_key", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_finding_reviews_source_idx" ON "saas_finding_reviews" ("source_id");
--> statement-breakpoint
ALTER TABLE "saas_finding_reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_finding_reviews" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_finding_reviews_admin" ON "saas_finding_reviews";
--> statement-breakpoint
CREATE POLICY "saas_finding_reviews_admin" ON "saas_finding_reviews" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
