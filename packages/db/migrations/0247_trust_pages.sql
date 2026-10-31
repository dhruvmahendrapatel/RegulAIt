-- ADR-0225 (P13 d, owner 2026-10-30) — outward trust pages: a public trust centre, per-system AI cards and a
-- named external auditor's read-only portal. Hand-written; never `drizzle-kit generate`.
--
-- 1. `org_settings.trust_pages_enabled` ships FALSE (ADR-0180): off, the public pages answer 404 and nothing can be
--    published or granted.
-- 2. `trust_publications`: what an admin chose to publish, as a reviewed snapshot. Every row starts as a draft.
-- 3. `trust_center_profile`: the trust centre's heading, one row.
-- 4. `auditor_grants` / `auditor_grant_items` / `auditor_links` / `auditor_sessions`: time-boxed (<= 90 days), scoped,
--    revocable access for a named auditor. Links (<= 72 hours, single use) and sessions (<= 8 hours) store only the
--    SHA-256 of their token.
--
-- No function and no trigger (the 0185 search_path and TRUNCATE guards have nothing to check). No backfill: every
-- table is new, and the setting's default is the strict value.

ALTER TABLE "org_settings" ADD COLUMN "trust_pages_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "trust_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "public_slug" text NOT NULL,
  "source_ref" text NOT NULL,
  "title" text NOT NULL,
  "content" jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "audience" text DEFAULT 'public' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "published_at" timestamp with time zone,
  "published_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trust_publications_public_slug_uq" UNIQUE ("public_slug"),
  CONSTRAINT "trust_publications_kind_check" CHECK ("kind" IN ('control', 'evidence_summary', 'ai_card')),
  CONSTRAINT "trust_publications_status_check" CHECK ("status" IN ('draft', 'published')),
  CONSTRAINT "trust_publications_audience_check" CHECK ("audience" IN ('public', 'auditors')),
  CONSTRAINT "trust_publications_slug_check" CHECK ("public_slug" ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  CONSTRAINT "trust_publications_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "trust_publications_source_check" CHECK (length("source_ref") BETWEEN 1 AND 300),
  CONSTRAINT "trust_publications_content_check" CHECK (jsonb_typeof("content") = 'object'),
  CONSTRAINT "trust_publications_version_check" CHECK ("version" >= 1),
  CONSTRAINT "trust_publications_published_check" CHECK (("status" = 'published') = ("published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "trust_publications_status_idx" ON "trust_publications" ("status", "audience");
--> statement-breakpoint
CREATE TABLE "trust_center_profile" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "display_name" text NOT NULL,
  "intro" text DEFAULT '' NOT NULL,
  "contact_email" text,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trust_center_profile_singleton" CHECK ("id" = 'singleton'),
  CONSTRAINT "trust_center_profile_name_check" CHECK (length(btrim("display_name")) BETWEEN 1 AND 120),
  CONSTRAINT "trust_center_profile_intro_check" CHECK (length("intro") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "auditor_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "auditor_name" text NOT NULL,
  "auditor_email" text NOT NULL,
  "auditor_organisation" text,
  "starts_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auditor_grants_name_check" CHECK (length(btrim("auditor_name")) BETWEEN 1 AND 120),
  CONSTRAINT "auditor_grants_email_check" CHECK (length("auditor_email") BETWEEN 3 AND 254 AND position('@' in "auditor_email") > 1),
  CONSTRAINT "auditor_grants_window_check" CHECK ("expires_at" > "starts_at" AND "expires_at" - "starts_at" <= interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "auditor_grant_items" (
  "grant_id" uuid NOT NULL REFERENCES "auditor_grants"("id") ON DELETE CASCADE,
  "publication_id" uuid NOT NULL REFERENCES "trust_publications"("id") ON DELETE CASCADE,
  CONSTRAINT "auditor_grant_items_grant_id_publication_id_pk" PRIMARY KEY ("grant_id", "publication_id")
);
--> statement-breakpoint
CREATE INDEX "auditor_grant_items_publication_idx" ON "auditor_grant_items" ("publication_id");
--> statement-breakpoint
CREATE TABLE "auditor_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "auditor_grants"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auditor_links_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "auditor_links_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "auditor_links_ttl_check" CHECK ("expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '72 hours')
);
--> statement-breakpoint
CREATE INDEX "auditor_links_grant_idx" ON "auditor_links" ("grant_id");
--> statement-breakpoint
CREATE TABLE "auditor_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "auditor_grants"("id") ON DELETE CASCADE,
  "link_id" uuid NOT NULL REFERENCES "auditor_links"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auditor_sessions_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "auditor_sessions_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "auditor_sessions_ttl_check" CHECK ("expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '8 hours')
);
--> statement-breakpoint
CREATE INDEX "auditor_sessions_grant_idx" ON "auditor_sessions" ("grant_id");
