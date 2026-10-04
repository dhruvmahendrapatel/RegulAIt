-- ADR-0175 batch D2 — A6 skill admission and integrity, A5 release-age cooldown.
--
-- A6: every builder skill carries a sha256 content digest, a version that goes
-- up on each body change, and an admission verdict from the ADR-0097 scanner
-- (unscanned | clean | held | refused | admitted). Pre-0140 rows are
-- 'unscanned': usable until the ADR-0100 sweep or the next edit scans them.
-- The PINNED body on each attachment is what an agent runs, so it carries its
-- own digest, version and verdict. A widening of visibility waits for an admin
-- in requested_visibility.
--
-- A5: org_settings.min_release_age_days (0 = off, the default) and this
-- deployment's own first-sighting record per exact digest, plus per-item admin
-- overrides. Nothing here changes behaviour while the setting is 0.
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "content_digest" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admission_state" text DEFAULT 'unscanned' NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admission_findings" jsonb;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admission_severity" text;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admission_scanned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admission_scanner_version" text;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admitted_by" uuid;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admitted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admit_reason" text;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "admitted_digest" text;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "requested_visibility" text;
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD COLUMN IF NOT EXISTS "visibility_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_skills" DROP CONSTRAINT IF EXISTS "builder_skills_admission_state_ck";
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD CONSTRAINT "builder_skills_admission_state_ck"
  CHECK ("admission_state" IN ('unscanned', 'clean', 'held', 'refused', 'admitted'));
--> statement-breakpoint
ALTER TABLE "builder_skills" DROP CONSTRAINT IF EXISTS "builder_skills_admission_severity_ck";
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD CONSTRAINT "builder_skills_admission_severity_ck"
  CHECK ("admission_severity" IS NULL OR "admission_severity" IN ('low', 'medium', 'high', 'critical'));
--> statement-breakpoint
ALTER TABLE "builder_skills" DROP CONSTRAINT IF EXISTS "builder_skills_requested_visibility_ck";
--> statement-breakpoint
ALTER TABLE "builder_skills" ADD CONSTRAINT "builder_skills_requested_visibility_ck"
  CHECK ("requested_visibility" IS NULL OR "requested_visibility" IN ('private', 'workspace'));
--> statement-breakpoint
UPDATE "builder_skills" SET "content_digest" = encode(sha256(convert_to("body", 'UTF8')), 'hex') WHERE "content_digest" = '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_skills_admission_idx" ON "builder_skills" ("admission_state");
--> statement-breakpoint
ALTER TABLE "builder_agent_skills" ADD COLUMN IF NOT EXISTS "snapshot_digest" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_agent_skills" ADD COLUMN IF NOT EXISTS "snapshot_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_agent_skills" ADD COLUMN IF NOT EXISTS "snapshot_admission_state" text DEFAULT 'unscanned' NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_agent_skills" DROP CONSTRAINT IF EXISTS "builder_agent_skills_snapshot_state_ck";
--> statement-breakpoint
ALTER TABLE "builder_agent_skills" ADD CONSTRAINT "builder_agent_skills_snapshot_state_ck"
  CHECK ("snapshot_admission_state" IN ('unscanned', 'clean', 'held', 'refused', 'admitted'));
--> statement-breakpoint
UPDATE "builder_agent_skills" SET "snapshot_digest" = encode(sha256(convert_to("body_snapshot", 'UTF8')), 'hex') WHERE "snapshot_digest" = '';
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "release_digest" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "release_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- an existing server has been known since it was registered
UPDATE "mcp_servers" SET "release_seen_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "min_release_age_days" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_min_release_age_days_ck";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_min_release_age_days_ck"
  CHECK ("min_release_age_days" >= 0 AND "min_release_age_days" <= 365);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_sightings" (
  "kind" text NOT NULL,
  "digest" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "release_sightings_pk" PRIMARY KEY ("kind", "digest"),
  CONSTRAINT "release_sightings_kind_ck" CHECK ("kind" IN ('skill', 'mcp_manifest', 'registry_entry'))
);
--> statement-breakpoint
-- the bodies that exist today were first seen no later than their last edit
INSERT INTO "release_sightings" ("kind", "digest", "first_seen_at")
  SELECT 'skill', "content_digest", min("updated_at") FROM "builder_skills" GROUP BY "content_digest"
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "release_sightings" ("kind", "digest", "first_seen_at")
  SELECT 'skill', "snapshot_digest", min("skill_updated_at") FROM "builder_agent_skills" GROUP BY "snapshot_digest"
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "digest" text NOT NULL,
  "overridden_by" uuid,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "release_overrides_kind_ck" CHECK ("kind" IN ('mcp_server', 'skill'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_overrides_uq" ON "release_overrides" ("kind", "subject_id", "digest");
