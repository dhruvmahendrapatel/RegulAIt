-- ADR-0215 (P5): framework content imports. Hand-authored (never drizzle-kit generate). Re-runnable.
--
-- 1. `org_settings.framework_imports_enabled` is OFF by default (ADR-0180): with it off the import routes refuse and
--    nothing is proposed. Turning it on is a relaxation (settings_relax step-up, audited).
-- 2. One row per import proposal. `snapshot` holds the imported control text exactly as vendored; once the row is
--    `accepted` it is the BASELINE the next import of the same source compares against, so a control whose text an
--    admin changed since then is detected and kept. `plan` is the reviewed diff, `take_incoming` the controls an admin
--    explicitly chose to overwrite.
-- 3. Accepting creates a NEW draft pack version (`resulting_pack_id`); no pack row is ever updated. No foreign key on
--    the pack ids: a draft pack can be deleted, and the proposal stays as the record of what was reviewed.
-- 4. At most one pending and one accepted proposal per source (partial unique indexes). Accepting supersedes the
--    previous accepted row in the same transaction as the audit row.
-- 5. No functions and no triggers (so nothing for the 0185 guard to pin).

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "framework_imports_enabled" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "framework_import_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" text NOT NULL,
  "framework" text NOT NULL,
  "source_version" text NOT NULL,
  "content_sha256" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "base_pack_id" uuid,
  "base_pack_version" integer,
  "plan" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "take_incoming" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "resulting_pack_id" uuid,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  CONSTRAINT "framework_import_proposals_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected', 'superseded')),
  CONSTRAINT "framework_import_proposals_sha_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "framework_import_proposals_source_check" CHECK ("source_id" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT "framework_import_proposals_decided_check" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "framework_import_proposals_result_check" CHECK (("status" IN ('accepted', 'superseded')) = ("resulting_pack_id" IS NOT NULL)),
  CONSTRAINT "framework_import_proposals_base_check" CHECK (("base_pack_id" IS NULL) = ("base_pack_version" IS NULL)),
  CONSTRAINT "framework_import_proposals_take_check" CHECK (jsonb_typeof("take_incoming") = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS "framework_import_proposals_one_pending_uq"
  ON "framework_import_proposals" ("source_id") WHERE "status" = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS "framework_import_proposals_one_accepted_uq"
  ON "framework_import_proposals" ("source_id") WHERE "status" = 'accepted';
CREATE INDEX IF NOT EXISTS "framework_import_proposals_source_idx"
  ON "framework_import_proposals" ("source_id", "created_at");
