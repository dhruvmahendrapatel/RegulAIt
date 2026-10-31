-- ADR-0215 (P5): the imported regulatory feed. Hand-authored (never drizzle-kit generate). Re-runnable.
--
-- 1. One row per proposed feed snapshot from a vendored source (the Federal Register search first). `entries` holds
--    the normalised entries; `diff` what accepting would add, remove or change against the accepted row.
-- 2. The ADR-0158 feed reads the hand-curated entries plus the ONE accepted row per source (partial unique index). A
--    curated entry wins a key collision. Nothing joins the feed until an admin accepts it, audited in the same
--    transaction; accepting supersedes the previous accepted row.
-- 3. Gated by `org_settings.framework_imports_enabled` (0248). No functions and no triggers.

CREATE TABLE IF NOT EXISTS "regulatory_feed_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" text NOT NULL,
  "source_version" text NOT NULL,
  "content_sha256" text NOT NULL,
  "source" jsonb NOT NULL,
  "entries" jsonb NOT NULL,
  "diff" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  CONSTRAINT "regulatory_feed_imports_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected', 'superseded')),
  CONSTRAINT "regulatory_feed_imports_sha_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "regulatory_feed_imports_source_check" CHECK ("source_id" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT "regulatory_feed_imports_decided_check" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "regulatory_feed_imports_entries_check" CHECK (jsonb_typeof("entries") = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS "regulatory_feed_imports_one_pending_uq"
  ON "regulatory_feed_imports" ("source_id") WHERE "status" = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS "regulatory_feed_imports_one_accepted_uq"
  ON "regulatory_feed_imports" ("source_id") WHERE "status" = 'accepted';
CREATE INDEX IF NOT EXISTS "regulatory_feed_imports_source_idx"
  ON "regulatory_feed_imports" ("source_id", "created_at");
