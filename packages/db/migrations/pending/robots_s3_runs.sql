-- ADR-0364 S3 (lane E45): robot runs execute. Run evidence, the placement a run used, and the free-form settings
-- that have no default (owner decision pending: free-form browsing stays off until both are set).
--
-- Sorts after robots.sql (byte order: '.' < '_'), which creates robot_runs.
--
--  - robot_runs.execution_placement_id: the decision 7 placement the run executed under (set once, by the gateway).
--  - robot_run_evidence: one row per stored evidence item (a redacted screenshot, a download, the run's egress log;
--    the log alone takes the reserved item 64).
--    The bytes live in the content-addressed store under `sha256/<hex>`; the row is append-only (no UPDATE, no
--    DELETE, no TRUNCATE): evidence leaves only by retention expiry, a later slice's recorded sweep.
--  - org_settings.freeform_browser_session_budget_usd / freeform_browser_max_run_minutes: the owner's limits for a
--    free-form browser session (decision 2026-11-19, ADR-0364 addendum): $2 per session against the project budget,
--    30 minutes at most. Free-form browsing itself stays off (per-user opt-in, §4); these bound it once it exists.
--  - projects.freeform_browser_budget_usd: an admin's per-project override of that $2 (NULL = the org default).

ALTER TABLE "robot_runs" ADD COLUMN IF NOT EXISTS "execution_placement_id" uuid REFERENCES "execution_placements"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_runs_placement_idx" ON "robot_runs" ("execution_placement_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_run_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "robot_run_id" uuid NOT NULL REFERENCES "robot_runs"("id") ON DELETE RESTRICT,
  "item" integer NOT NULL,
  "kind" text NOT NULL,
  "step" integer,
  "content_type" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "robot_run_evidence_item_uq" UNIQUE ("robot_run_id", "item"),
  CONSTRAINT "robot_run_evidence_kind_check" CHECK ("kind" IN ('screenshot', 'download', 'egress_log')),
  CONSTRAINT "robot_run_evidence_type_check" CHECK ("content_type" IN ('image/jpeg', 'application/octet-stream', 'text/plain')),
  CONSTRAINT "robot_run_evidence_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "robot_run_evidence_item_check" CHECK ("item" >= 0 AND "item" <= 64),
  CONSTRAINT "robot_run_evidence_size_check" CHECK ("size_bytes" >= 0 AND "size_bytes" <= 10485760),
  CONSTRAINT "robot_run_evidence_step_check" CHECK ("step" IS NULL OR ("step" >= 0 AND "step" <= 500))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_run_evidence_sha_idx" ON "robot_run_evidence" ("sha256");
--> statement-breakpoint
-- items 0..63 are the runner's (a screenshot or a download); item 64 is reserved for the executor's egress log, and
-- only the egress log may take it (ROBOT_EGRESS_LOG_ITEM). The (run, item) unique key then allows one log per run,
-- which a runner can neither forge nor crowd out by filling its own items. Re-stated here so a database that applied
-- an earlier draft of this pending file gets the same pair of checks.
ALTER TABLE "robot_run_evidence" DROP CONSTRAINT IF EXISTS "robot_run_evidence_item_check";
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" ADD CONSTRAINT "robot_run_evidence_item_check" CHECK ("item" >= 0 AND "item" <= 64);
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" DROP CONSTRAINT IF EXISTS "robot_run_evidence_egress_slot_check";
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" ADD CONSTRAINT "robot_run_evidence_egress_slot_check"
  CHECK (("item" = 64) = ("kind" = 'egress_log'));
--> statement-breakpoint
-- why an item's bytes were never kept (NULL = they are in the store under the sha256): `pii_block` (the project's PII
-- mode is `block`, so a download is recorded by its sha256 and size only, §7) or `no_store` (no store configured)
ALTER TABLE "robot_run_evidence" ADD COLUMN IF NOT EXISTS "bytes_withheld" text;
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" DROP CONSTRAINT IF EXISTS "robot_run_evidence_withheld_check";
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" ADD CONSTRAINT "robot_run_evidence_withheld_check"
  CHECK ("bytes_withheld" IS NULL OR "bytes_withheld" IN ('pii_block', 'no_store'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION regulait_robot_run_evidence_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'robot run evidence is append-only (ADR-0364 §7)';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "robot_run_evidence_append_only" ON public."robot_run_evidence";
--> statement-breakpoint
CREATE TRIGGER "robot_run_evidence_append_only" BEFORE UPDATE OR DELETE ON public."robot_run_evidence"
  FOR EACH ROW EXECUTE FUNCTION regulait_robot_run_evidence_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "robot_run_evidence_no_truncate" ON public."robot_run_evidence";
--> statement-breakpoint
CREATE TRIGGER "robot_run_evidence_no_truncate" BEFORE TRUNCATE ON public."robot_run_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- the run's readers (requester, robot owner, admin) read its evidence; only the gateway's system task writes it
DROP POLICY IF EXISTS robot_run_evidence_select ON "robot_run_evidence";
--> statement-breakpoint
CREATE POLICY robot_run_evidence_select ON "robot_run_evidence" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR EXISTS (SELECT 1 FROM "robot_runs" rr JOIN "robot_versions" v ON v."id" = rr."robot_version_id" JOIN "robots" r ON r."id" = v."robot_id"
    WHERE rr."id" = "robot_run_id" AND (rr."requested_by" = (SELECT regulait_rls_user_id()) OR r."owner_user_id" = (SELECT regulait_rls_user_id())))
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_run_evidence_insert ON "robot_run_evidence";
--> statement-breakpoint
CREATE POLICY robot_run_evidence_insert ON "robot_run_evidence" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "freeform_browser_session_budget_usd" double precision NOT NULL DEFAULT 2;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "freeform_browser_max_run_minutes" integer NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_freeform_browser_budget_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_freeform_browser_budget_check"
  CHECK ("freeform_browser_session_budget_usd" > 0 AND "freeform_browser_session_budget_usd" <= 1000);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_freeform_browser_minutes_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_freeform_browser_minutes_check"
  CHECK ("freeform_browser_max_run_minutes" >= 1 AND "freeform_browser_max_run_minutes" <= 30);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "freeform_browser_budget_usd" double precision;
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_freeform_browser_budget_check";
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_freeform_browser_budget_check"
  CHECK ("freeform_browser_budget_usd" IS NULL OR ("freeform_browser_budget_usd" > 0 AND "freeform_browser_budget_usd" <= 1000));
--> statement-breakpoint
-- the offer a robot run was placed under names that run (robot_browser_isolation.sql adds the column; it sorts before
-- robots.sql, so the foreign key is added here, once robot_runs exists)
ALTER TABLE "execution_offers" DROP CONSTRAINT IF EXISTS "execution_offers_robot_run_fk";
--> statement-breakpoint
ALTER TABLE "execution_offers" ADD CONSTRAINT "execution_offers_robot_run_fk" FOREIGN KEY ("robot_run_id") REFERENCES "robot_runs"("id") ON DELETE RESTRICT;
