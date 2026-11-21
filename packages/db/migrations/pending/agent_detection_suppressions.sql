-- ADR-0333 §5b (lane E15, slice 4): per-rule detection suppressions.
--
-- `detection_suppressions`: while a row is `active` and before `expires_at`, matches of `rule_id` in exactly
-- `group_key` raise no incident; the sweep counts them in a `detection-suppressed` audit row instead. Expiry is derived
-- from `expires_at` (never stored), at most 30 days after creation. Its lifecycle is the ADR-0348 machine
-- DETECTION_SUPPRESSION_MACHINE (active -> revoked). Row-level security (ADR-0234), ENABLED and FORCED, with the
-- incident tables' policy: an admin principal, or the sweep (`system_task`) and migrations. One deployment is one
-- tenant (ADR-0041), so this is the tenant scope.
CREATE TABLE IF NOT EXISTS "detection_suppressions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" text NOT NULL,
  "group_key" text NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "create_step_up" text NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid,
  CONSTRAINT "detection_suppressions_rule_id_check" CHECK ("rule_id" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT "detection_suppressions_group_key_check" CHECK ("group_key" ~ '^(grant|user|endpoint):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT "detection_suppressions_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "detection_suppressions_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "detection_suppressions_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'),
  CONSTRAINT "detection_suppressions_step_up_check" CHECK ("create_step_up" ~ '^[a-z_]{1,32}$'),
  CONSTRAINT "detection_suppressions_revoked_check" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL) AND ("revoked_by" IS NULL OR "status" = 'revoked') AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at"))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_suppressions" ADD CONSTRAINT "detection_suppressions_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_suppressions" ADD CONSTRAINT "detection_suppressions_revoked_by_users_id_fk"
    FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "detection_suppressions_match_idx" ON "detection_suppressions" USING btree ("group_key", "rule_id", "expires_at") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "detection_suppressions_created_idx" ON "detection_suppressions" USING btree ("created_at", "id");
--> statement-breakpoint
ALTER TABLE "detection_suppressions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "detection_suppressions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "detection_suppressions_admin" ON "detection_suppressions";
--> statement-breakpoint
CREATE POLICY "detection_suppressions_admin" ON "detection_suppressions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
