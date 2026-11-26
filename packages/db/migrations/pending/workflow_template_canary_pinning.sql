-- ADR-0340 slice 3 (lane E21), rebuilt on ADR-0341's `workflow_template_versions`: instance pinning, canary rollout and
-- governed in-flight migration. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
-- No change to an existing column. Template versions stay where ADR-0341 keeps them; nothing here is a second store.
--
-- 1. `workflow_template_versions` gains a UNIQUE (template_id, id) so the tables below can reference a version AND
--    its template with one composite foreign key (a canary's two versions are of its own template).
-- 2. `origin` learns `canary_rollback`: ending a canary with a rollback publishes the stable definition again as the
--    next version (a restore is a publish, ADR-0341 §5). The 0410 precedent: drop the CHECK, add it again.
-- 3. `workflow_template_canaries`: a canary over NEW instances of a template (1 to 50 percent get the canary version,
--    the rest the stable one). At most one open per template; it ends promoted or rolled back, once.
-- 4. `workflow_instance_template_versions`: which version served each instance (a row per template at start, a row
--    per applied migration). Append-only evidence.
-- 5. `workflow_instance_migrations`: a request to move one running instance to another version of its template,
--    decided in the one approvals queue (kind `workflow_migration`). At most one open request per instance.
-- Deployment-wide like `workflow_templates` (no tenant column, so no RLS policy); the routes are admin-only.
-- `regulait_app` gets DML on the new tables through 0272's default privileges.

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_template_versions_template_id_uq" ON "workflow_template_versions" ("template_id", "id");
--> statement-breakpoint
ALTER TABLE "workflow_template_versions" DROP CONSTRAINT IF EXISTS "workflow_template_versions_origin_check";
--> statement-breakpoint
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_origin_check"
  CHECK ("origin" IN ('baseline', 'builder', 'governance_apply', 'canary_rollback'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_template_canaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- the template both versions belong to, enforced by the two composite foreign keys below (not a free copy)
  "template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "canary_version_id" uuid NOT NULL,
  "stable_version_id" uuid NOT NULL,
  "percent" integer NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "started_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "ended_at" timestamp with time zone,
  "end_reason" text,
  CONSTRAINT "workflow_template_canaries_canary_fk" FOREIGN KEY ("template_id", "canary_version_id")
    REFERENCES "workflow_template_versions"("template_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workflow_template_canaries_stable_fk" FOREIGN KEY ("template_id", "stable_version_id")
    REFERENCES "workflow_template_versions"("template_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workflow_template_canaries_percent_check" CHECK ("percent" BETWEEN 1 AND 50),
  CONSTRAINT "workflow_template_canaries_distinct_check" CHECK ("canary_version_id" <> "stable_version_id"),
  CONSTRAINT "workflow_template_canaries_status_check" CHECK ("status" IN ('open', 'promoted', 'rolled_back')),
  CONSTRAINT "workflow_template_canaries_end_check" CHECK (
    ("status" = 'open' AND "ended_at" IS NULL AND "end_reason" IS NULL)
    OR ("status" <> 'open' AND "ended_at" IS NOT NULL AND "end_reason" IS NOT NULL AND length("end_reason") BETWEEN 10 AND 500)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_template_canaries_one_open_uq" ON "workflow_template_canaries" ("template_id") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_template_canaries_canary_version_idx" ON "workflow_template_canaries" ("template_id", "canary_version_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_template_canaries_stable_version_idx" ON "workflow_template_canaries" ("template_id", "stable_version_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_instance_template_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "template_version_id" uuid NOT NULL REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE,
  -- point-in-time fact of the selection: a canary bucket served this instance (not a copy of the canary's status)
  "canary" boolean DEFAULT false NOT NULL,
  "via" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_instance_template_versions_via_check" CHECK ("via" IN ('start', 'migration'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_instance_template_versions_instance_idx" ON "workflow_instance_template_versions" ("instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_instance_template_versions_version_idx" ON "workflow_instance_template_versions" ("template_version_id");
--> statement-breakpoint
-- pins are evidence of what ran: append-only. The two-argument form lets the cascade of the row's OWN parent through
-- (an instance deleted by a test fixture); a version's own cascade comes from its template, as 0408 allows for it.
DROP TRIGGER IF EXISTS "workflow_instance_template_versions_append_only" ON "workflow_instance_template_versions";
--> statement-breakpoint
CREATE TRIGGER "workflow_instance_template_versions_append_only" BEFORE UPDATE ON "workflow_instance_template_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('instance_id', 'workflow_instances');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_instance_template_versions_no_truncate" ON public."workflow_instance_template_versions";
--> statement-breakpoint
CREATE TRIGGER "workflow_instance_template_versions_no_truncate" BEFORE TRUNCATE ON public."workflow_instance_template_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_instance_migrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "target_version_id" uuid NOT NULL REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  -- point-in-time evidence: the dry-run plan and RFC 6902 diff the approver reviewed, as computed at the request
  "plan" jsonb NOT NULL,
  "from_definition_sha256" text NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_instance_migrations_status_check" CHECK ("status" IN ('pending', 'applied', 'denied', 'stale')),
  CONSTRAINT "workflow_instance_migrations_sha_check" CHECK ("from_definition_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workflow_instance_migrations_reason_check" CHECK (length("reason") BETWEEN 10 AND 500)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_instance_migrations_instance_idx" ON "workflow_instance_migrations" ("instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_instance_migrations_target_idx" ON "workflow_instance_migrations" ("target_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_instance_migrations_one_pending_uq" ON "workflow_instance_migrations" ("instance_id") WHERE "status" = 'pending';
