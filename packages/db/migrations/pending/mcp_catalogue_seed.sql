-- ADR-0256: seeding the MCP catalogue from the official MCP Registry, community lists and signed offline bundles.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `mcp_registries.listing_kind` ('registry' | 'community') and `mcp_registries.delivery` ('pull' |
--    'offline_bundle'). Every existing row is an ADR-0101 registry pull, which is what the defaults say. Vetting is
--    derived from listing_kind (community = unvetted), never stored per entry.
-- 2. `mcp_catalogue_items`: one row per server as the catalogue understands it, keyed by the dedupe key
--    (`repo:github.com/owner/repo`, else `name:<upstream name>`). Source rows stay in `mcp_registry_entries`, one per
--    source, so provenance is never merged away.
-- 3. `mcp_catalogue_snapshots`: one APPEND-ONLY row per successful refresh of a source (a pull or a bundle import):
--    what was asserted, when, by whom, its content digest and, for a bundle, the key that signed it. Evidence:
--    UPDATE, DELETE and TRUNCATE are refused (0185's pattern, functions pin search_path).
-- 4. `mcp_registry_entries` gains `catalogue_item_id`, `paid_signal` and `last_snapshot_id`. Nothing is backfilled:
--    a row from before this migration is linked by the next refresh of its source (NULL until then).
--
-- No row is inserted. A fresh install still has zero sources; seeding is an admin act (ADR-0180).

ALTER TABLE "mcp_registries" ADD COLUMN IF NOT EXISTS "listing_kind" text DEFAULT 'registry' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_registries" ADD COLUMN IF NOT EXISTS "delivery" text DEFAULT 'pull' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_registries" DROP CONSTRAINT IF EXISTS "mcp_registries_listing_kind_check";
--> statement-breakpoint
ALTER TABLE "mcp_registries" ADD CONSTRAINT "mcp_registries_listing_kind_check" CHECK ("listing_kind" IN ('registry', 'community'));
--> statement-breakpoint
ALTER TABLE "mcp_registries" DROP CONSTRAINT IF EXISTS "mcp_registries_delivery_check";
--> statement-breakpoint
ALTER TABLE "mcp_registries" ADD CONSTRAINT "mcp_registries_delivery_check" CHECK ("delivery" IN ('pull', 'offline_bundle'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_catalogue_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dedupe_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_catalogue_items_dedupe_key_len" CHECK (char_length("dedupe_key") BETWEEN 1 AND 400)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_catalogue_items_dedupe_key_uq" ON "mcp_catalogue_items" ("dedupe_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_catalogue_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "registry_id" uuid NOT NULL REFERENCES "mcp_registries"("id") ON DELETE RESTRICT,
  -- point-in-time copies of the source's kind and delivery AS IT WAS refreshed (evidence, ADR-0200 addendum)
  "listing_kind" text NOT NULL,
  "delivery" text NOT NULL,
  -- the admin who triggered it, or NULL for the scheduler; evidence, so no foreign key that could rewrite it
  "actor_user_id" uuid,
  "entry_count" integer NOT NULL,
  "truncated" boolean NOT NULL,
  -- sha256 over the sorted per-entry release digests the refresh saw
  "content_digest" text NOT NULL,
  -- a bundle import only: the trusted key id, the sha256 of the signed bytes and the bundle's own createdAt
  "bundle_key_id" text,
  "bundle_digest" text,
  "bundle_created_at" timestamp with time zone,
  "taken_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_catalogue_snapshots_listing_kind_check" CHECK ("listing_kind" IN ('registry', 'community')),
  CONSTRAINT "mcp_catalogue_snapshots_delivery_check" CHECK ("delivery" IN ('pull', 'offline_bundle')),
  CONSTRAINT "mcp_catalogue_snapshots_count_check" CHECK ("entry_count" >= 0),
  CONSTRAINT "mcp_catalogue_snapshots_bundle_check" CHECK (
    ("delivery" = 'offline_bundle' AND "bundle_key_id" IS NOT NULL AND "bundle_digest" IS NOT NULL AND "bundle_created_at" IS NOT NULL)
    OR ("delivery" = 'pull' AND "bundle_key_id" IS NULL AND "bundle_digest" IS NULL AND "bundle_created_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_catalogue_snapshots_registry_idx" ON "mcp_catalogue_snapshots" ("registry_id", "taken_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."mcp_catalogue_snapshots_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'mcp_catalogue_snapshots rows are append-only evidence (ADR-0256)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_catalogue_snapshots_guard" ON public."mcp_catalogue_snapshots";
--> statement-breakpoint
CREATE TRIGGER "mcp_catalogue_snapshots_guard" BEFORE UPDATE OR DELETE ON public."mcp_catalogue_snapshots"
  FOR EACH ROW EXECUTE FUNCTION public."mcp_catalogue_snapshots_guard"();
--> statement-breakpoint
-- a TRUNCATE skips every row trigger: refused that way too (0185's pattern)
DROP TRIGGER IF EXISTS "mcp_catalogue_snapshots_no_truncate" ON public."mcp_catalogue_snapshots";
--> statement-breakpoint
CREATE TRIGGER "mcp_catalogue_snapshots_no_truncate" BEFORE TRUNCATE ON public."mcp_catalogue_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries" ADD COLUMN IF NOT EXISTS "catalogue_item_id" uuid REFERENCES "mcp_catalogue_items"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries" ADD COLUMN IF NOT EXISTS "paid_signal" text;
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries" ADD COLUMN IF NOT EXISTS "last_snapshot_id" uuid REFERENCES "mcp_catalogue_snapshots"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries" DROP CONSTRAINT IF EXISTS "mcp_registry_entries_paid_signal_check";
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries" ADD CONSTRAINT "mcp_registry_entries_paid_signal_check" CHECK ("paid_signal" IS NULL OR "paid_signal" IN ('x402', 'paid'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_registry_entries_item_idx" ON "mcp_registry_entries" ("catalogue_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_registry_entries_snapshot_idx" ON "mcp_registry_entries" ("last_snapshot_id");
