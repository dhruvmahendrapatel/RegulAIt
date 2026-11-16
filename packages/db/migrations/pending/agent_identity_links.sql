-- ADR-0339 slice 2 (lane E20): author vs runner, and non-human identity links.
--
-- 1. `agent_authorship`: who built each agent, one row per agent, recorded by the insert triggers below in the
--    creating transaction: a registry agent's author is the request's row-level-security principal
--    (`regulait_rls_user_id()`, when it names an existing user), a builder agent's is its owner at creation. Never
--    rewritten (UPDATE refused except the SET NULL of a deleted author; DELETE only with the agent; TRUNCATE refused).
--    Agents that existed before are backfilled `unknown`: an author is never guessed (ADR-0180, no grandfathering of a
--    fact we do not have).
-- 2. `agent_identity_links`: an agent's cloud service account, vendor agent identity or OAuth client. Staged by an
--    admin or an importer; a SECOND admin confirms or rejects it (four-eyes CHECK). A link confers nothing.
--
-- Not tenant-scoped data (ADR-0234 scope): admin or steward routes only, no RLS batch. Every function pins its
-- search_path (zz-dbguard-0185). Hand-authored, additive and idempotent.
CREATE TABLE IF NOT EXISTS "agent_authorship" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "builder_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "source" text NOT NULL,
  "vendor_creator_pseudonym" text,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_authorship_subject_check" CHECK (num_nonnulls("agent_id", "builder_agent_id") = 1),
  CONSTRAINT "agent_authorship_source_check" CHECK ("source" IN ('principal', 'builder_owner', 'vendor_record', 'unknown')),
  CONSTRAINT "agent_authorship_unknown_check" CHECK ("source" <> 'unknown' OR "author_user_id" IS NULL),
  CONSTRAINT "agent_authorship_vendor_check" CHECK (
    ("source" = 'vendor_record') = ("vendor_creator_pseudonym" IS NOT NULL)
    AND ("vendor_creator_pseudonym" IS NULL OR length("vendor_creator_pseudonym") BETWEEN 1 AND 128)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_authorship_agent_uq" ON "agent_authorship" ("agent_id") WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_authorship_builder_uq"
  ON "agent_authorship" ("builder_agent_id") WHERE "builder_agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_authorship_author_idx" ON "agent_authorship" ("author_user_id");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_authorship_append_only_agent" ON "agent_authorship";
--> statement-breakpoint
CREATE TRIGGER "agent_authorship_append_only_agent" BEFORE UPDATE OR DELETE ON "agent_authorship"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('agent_id', 'agents');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_authorship_append_only_builder" ON "agent_authorship";
--> statement-breakpoint
CREATE TRIGGER "agent_authorship_append_only_builder" BEFORE UPDATE OR DELETE ON "agent_authorship"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('builder_agent_id', 'builder_agents');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_authorship_no_truncate" ON public."agent_authorship";
--> statement-breakpoint
CREATE TRIGGER "agent_authorship_no_truncate" BEFORE TRUNCATE ON public."agent_authorship"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.regulait_agent_authorship_on_agent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  author uuid;
BEGIN
  SELECT u."id" INTO author FROM public.users u WHERE u."id" = public.regulait_rls_user_id();
  INSERT INTO public.agent_authorship ("agent_id", "author_user_id", "source")
    VALUES (NEW."id", author, CASE WHEN author IS NULL THEN 'unknown' ELSE 'principal' END);
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_authorship_insert" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "agents_authorship_insert" AFTER INSERT ON "agents"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_authorship_on_agent();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.regulait_agent_authorship_on_builder_agent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.agent_authorship ("builder_agent_id", "author_user_id", "source")
    VALUES (NEW."id", NEW."owner_user_id", 'builder_owner');
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agents_authorship_insert" ON "builder_agents";
--> statement-breakpoint
CREATE TRIGGER "builder_agents_authorship_insert" AFTER INSERT ON "builder_agents"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_authorship_on_builder_agent();
--> statement-breakpoint
INSERT INTO "agent_authorship" ("agent_id", "source")
  SELECT a."id", 'unknown' FROM "agents" a
  WHERE NOT EXISTS (SELECT 1 FROM "agent_authorship" x WHERE x."agent_id" = a."id");
--> statement-breakpoint
INSERT INTO "agent_authorship" ("builder_agent_id", "source")
  SELECT b."id", 'unknown' FROM "builder_agents" b
  WHERE NOT EXISTS (SELECT 1 FROM "agent_authorship" x WHERE x."builder_agent_id" = b."id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "builder_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "status" text DEFAULT 'staged' NOT NULL,
  "source" text NOT NULL,
  "note" text,
  "staged_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "staged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  CONSTRAINT "agent_identity_links_subject_check" CHECK (num_nonnulls("agent_id", "builder_agent_id") = 1),
  CONSTRAINT "agent_identity_links_kind_check" CHECK ("kind" IN ('cloud_service_account', 'vendor_agent_identity', 'oauth_client')),
  CONSTRAINT "agent_identity_links_provider_check" CHECK ("provider" IN ('aws', 'azure', 'gcp', 'entra', 'okta', 'other')),
  CONSTRAINT "agent_identity_links_status_check" CHECK ("status" IN ('staged', 'confirmed', 'rejected')),
  CONSTRAINT "agent_identity_links_source_check" CHECK ("source" IN ('admin', 'importer')),
  CONSTRAINT "agent_identity_links_external_id_check" CHECK (length("external_id") BETWEEN 1 AND 1024),
  CONSTRAINT "agent_identity_links_notes_check" CHECK (
    ("note" IS NULL OR length("note") <= 500) AND ("decision_note" IS NULL OR length("decision_note") <= 500)
  ),
  CONSTRAINT "agent_identity_links_decided_check" CHECK (("status" = 'staged') = ("decided_at" IS NULL)),
  CONSTRAINT "agent_identity_links_four_eyes_check" CHECK (
    "decided_by_user_id" IS NULL OR "staged_by_user_id" IS NULL OR "decided_by_user_id" <> "staged_by_user_id"
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_identity_links_agent_uq"
  ON "agent_identity_links" ("agent_id", "provider", "external_id") WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_identity_links_builder_uq"
  ON "agent_identity_links" ("builder_agent_id", "provider", "external_id") WHERE "builder_agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_identity_links_external_idx" ON "agent_identity_links" ("provider", "external_id");
