-- ADR-0339 (lane E20): the agent risk score, recomputed on every change.
--
-- 1. `agent_risk_recompute_requests`: an agent (registry or builder) waiting to be scored, one row per agent and
--    reason. Written ONLY by the triggers below, inside the transaction of the change itself, so every write path that
--    exists today or is added later marks the agent without the route having to remember. The sweep deletes the rows
--    it drained in the transaction that appends the assessment and its audit row.
-- 2. `agent_risk_assessments`: append-only evidence (UPDATE and DELETE refused except the cascade of the row's own
--    parent, TRUNCATE refused). The assessment jsonb is a commented point-in-time snapshot (ADR-0200 addendum).
-- 3. Mark triggers on: agents (insert = created, an update of a risk-relevant column = modified, and the builder agents
--    bound to that model), builder_agents (same), the builder agent's tools, schedules, sub-agents, channels and skills
--    (modified), its shares (access_changed), agent_grants, role_agent_grants and role_assignments (access_changed:
--    the reach changes), and config_versions becoming active for an agent artifact (published).
-- 4. Backfill: every agent and live builder agent is marked `backfill`, so the first sweep scores all of them.
--
-- Not tenant-scoped data (ADR-0234 scope): admin or steward routes only, no RLS batch. Every function pins its
-- search_path (zz-dbguard-0185). Hand-authored, additive and idempotent.
CREATE TABLE IF NOT EXISTS "agent_risk_recompute_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "builder_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_risk_recompute_requests_subject_check" CHECK (num_nonnulls("agent_id", "builder_agent_id") = 1),
  CONSTRAINT "agent_risk_recompute_requests_trigger_check"
    CHECK ("trigger" IN ('created', 'modified', 'published', 'access_changed', 'imported', 'backfill', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_risk_recompute_requests_agent_uq"
  ON "agent_risk_recompute_requests" ("agent_id", "trigger") WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_risk_recompute_requests_builder_uq"
  ON "agent_risk_recompute_requests" ("builder_agent_id", "trigger") WHERE "builder_agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_recompute_requests_requested_idx" ON "agent_risk_recompute_requests" ("requested_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_risk_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "builder_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "method_version" text NOT NULL,
  "score" integer NOT NULL,
  "band" text NOT NULL,
  "triggers" text[] NOT NULL,
  -- DELIBERATE EXCEPTION to third normal form (ADR-0200 addendum): a point-in-time evidence snapshot of the factors,
  -- combinations, reach and ranked fixes exactly as scored. The live score is recomputed on read.
  "assessment" jsonb NOT NULL,
  "assessment_digest" text NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_risk_assessments_subject_check" CHECK (num_nonnulls("agent_id", "builder_agent_id") = 1),
  CONSTRAINT "agent_risk_assessments_score_check" CHECK ("score" BETWEEN 0 AND 100),
  CONSTRAINT "agent_risk_assessments_band_check" CHECK ("band" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "agent_risk_assessments_method_check" CHECK ("method_version" ~ '^[a-z0-9.-]{1,32}$'),
  CONSTRAINT "agent_risk_assessments_digest_check" CHECK ("assessment_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "agent_risk_assessments_triggers_check" CHECK (
    cardinality("triggers") BETWEEN 1 AND 7
    AND "triggers" <@ ARRAY['created', 'modified', 'published', 'access_changed', 'imported', 'backfill', 'manual']::text[]
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_assessments_agent_idx"
  ON "agent_risk_assessments" ("agent_id", "computed_at", "id") WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_assessments_builder_idx"
  ON "agent_risk_assessments" ("builder_agent_id", "computed_at", "id") WHERE "builder_agent_id" IS NOT NULL;
--> statement-breakpoint
-- append-only: one trigger per parent, so each parent's cascade (and only that) may remove a row
DROP TRIGGER IF EXISTS "agent_risk_assessments_append_only_agent" ON "agent_risk_assessments";
--> statement-breakpoint
CREATE TRIGGER "agent_risk_assessments_append_only_agent" BEFORE UPDATE OR DELETE ON "agent_risk_assessments"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('agent_id', 'agents');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_risk_assessments_append_only_builder" ON "agent_risk_assessments";
--> statement-breakpoint
CREATE TRIGGER "agent_risk_assessments_append_only_builder" BEFORE UPDATE OR DELETE ON "agent_risk_assessments"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('builder_agent_id', 'builder_agents');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_risk_assessments_no_truncate" ON public."agent_risk_assessments";
--> statement-breakpoint
CREATE TRIGGER "agent_risk_assessments_no_truncate" BEFORE TRUNCATE ON public."agent_risk_assessments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
-- the one writer of the queue: marks an agent if it still exists (a cascade of its own deletion marks nothing)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_mark(p_agent uuid, p_builder uuid, p_trigger text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_agent IS NOT NULL THEN
    INSERT INTO public.agent_risk_recompute_requests ("agent_id", "trigger")
      SELECT a."id", p_trigger FROM public.agents a WHERE a."id" = p_agent
      ON CONFLICT ("agent_id", "trigger") WHERE "agent_id" IS NOT NULL DO UPDATE SET "requested_at" = now();
  END IF;
  IF p_builder IS NOT NULL THEN
    INSERT INTO public.agent_risk_recompute_requests ("builder_agent_id", "trigger")
      SELECT b."id", p_trigger FROM public.builder_agents b WHERE b."id" = p_builder AND b."archived_at" IS NULL
      ON CONFLICT ("builder_agent_id", "trigger") WHERE "builder_agent_id" IS NOT NULL DO UPDATE SET "requested_at" = now();
  END IF;
END $$;
--> statement-breakpoint
-- agents: created, modified (risk-relevant columns only; prices and review dates do not change the score)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_agent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  reason text := CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'modified' END;
  b record;
BEGIN
  PERFORM public.regulait_agent_risk_mark(NEW."id", NULL, reason);
  IF TG_OP = 'UPDATE' THEN
    -- a builder agent inherits its model binding's evidence (guardrails, sign-off, red-team), so it is re-scored too
    FOR b IN SELECT ba."id" FROM public.builder_agents ba WHERE ba."model_agent_id" = NEW."id" AND ba."archived_at" IS NULL LOOP
      PERFORM public.regulait_agent_risk_mark(NULL, b."id", 'modified');
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_risk_mark_insert" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "agents_risk_mark_insert" AFTER INSERT ON "agents"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_agent();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_risk_mark_update" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "agents_risk_mark_update" AFTER UPDATE OF
  "provider", "tier", "modes", "enabled", "halted_at", "owner_user_id", "lifecycle_status", "successor_user_id",
  "model", "system_prompt", "custom_provider_id", "expected_served_model"
  ON "agents" FOR EACH ROW
  WHEN ((OLD."provider", OLD."tier", OLD."modes", OLD."enabled", OLD."halted_at", OLD."owner_user_id",
         OLD."lifecycle_status", OLD."successor_user_id", OLD."model", OLD."system_prompt", OLD."custom_provider_id",
         OLD."expected_served_model")
        IS DISTINCT FROM
        (NEW."provider", NEW."tier", NEW."modes", NEW."enabled", NEW."halted_at", NEW."owner_user_id",
         NEW."lifecycle_status", NEW."successor_user_id", NEW."model", NEW."system_prompt", NEW."custom_provider_id",
         NEW."expected_served_model"))
  EXECUTE FUNCTION public.regulait_agent_risk_on_agent();
--> statement-breakpoint
-- builder agents: created, modified (not the spend-limit lease, which turns over on every chat turn)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_builder_agent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark(NULL, NEW."id", CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'modified' END);
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agents_risk_mark_insert" ON "builder_agents";
--> statement-breakpoint
CREATE TRIGGER "builder_agents_risk_mark_insert" AFTER INSERT ON "builder_agents"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_agent();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agents_risk_mark_update" ON "builder_agents";
--> statement-breakpoint
CREATE TRIGGER "builder_agents_risk_mark_update" AFTER UPDATE OF
  "owner_user_id", "sharing", "model_agent_id", "instructions", "computer_use", "monthly_limit_usd", "project_id",
  "declared_autonomy_class"
  ON "builder_agents" FOR EACH ROW
  WHEN ((OLD."owner_user_id", OLD."sharing", OLD."model_agent_id", OLD."instructions", OLD."computer_use",
         OLD."monthly_limit_usd", OLD."project_id", OLD."declared_autonomy_class")
        IS DISTINCT FROM
        (NEW."owner_user_id", NEW."sharing", NEW."model_agent_id", NEW."instructions", NEW."computer_use",
         NEW."monthly_limit_usd", NEW."project_id", NEW."declared_autonomy_class"))
  EXECUTE FUNCTION public.regulait_agent_risk_on_builder_agent();
--> statement-breakpoint
-- a builder agent's parts: TG_ARGV[0] is the column naming the agent, TG_ARGV[1] the reason
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_builder_part() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  row_json jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  PERFORM public.regulait_agent_risk_mark(NULL, (row_json ->> TG_ARGV[0])::uuid, TG_ARGV[1]);
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> TG_ARGV[0]) IS DISTINCT FROM (row_json ->> TG_ARGV[0]) THEN
    PERFORM public.regulait_agent_risk_mark(NULL, (to_jsonb(OLD) ->> TG_ARGV[0])::uuid, TG_ARGV[1]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agent_tools_risk_mark" ON "builder_agent_tools";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_tools_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_tools"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('agent_id', 'modified');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agent_schedules_risk_mark" ON "builder_agent_schedules";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_schedules_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_schedules"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('agent_id', 'modified');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agent_subagents_risk_mark" ON "builder_agent_subagents";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_subagents_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_subagents"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('parent_id', 'modified');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agent_channels_risk_mark" ON "builder_agent_channels";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_channels_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_channels"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('agent_id', 'modified');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agent_skills_risk_mark" ON "builder_agent_skills";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_skills_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_skills"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('agent_id', 'modified');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agent_shares_risk_mark" ON "builder_agent_shares";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_shares_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_shares"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('agent_id', 'access_changed');
--> statement-breakpoint
-- the reach of a registry agent: its direct grants, its role grants, and who holds those roles
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_agent_grant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark((to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> 'agent_id')::uuid, NULL, 'access_changed');
  IF TG_OP = 'UPDATE' AND OLD."agent_id" IS DISTINCT FROM NEW."agent_id" THEN
    PERFORM public.regulait_agent_risk_mark(OLD."agent_id", NULL, 'access_changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_grants_risk_mark" ON "agent_grants";
--> statement-breakpoint
CREATE TRIGGER "agent_grants_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "agent_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_agent_grant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "role_agent_grants_risk_mark" ON "role_agent_grants";
--> statement-breakpoint
CREATE TRIGGER "role_agent_grants_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "role_agent_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_agent_grant();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_role_assignment() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT rag."agent_id" FROM public.role_agent_grants rag
    WHERE rag."role_id" IN ((to_jsonb(NEW) ->> 'role_id')::uuid, (to_jsonb(OLD) ->> 'role_id')::uuid)
  LOOP
    PERFORM public.regulait_agent_risk_mark(g."agent_id", NULL, 'access_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "role_assignments_risk_mark" ON "role_assignments";
--> statement-breakpoint
CREATE TRIGGER "role_assignments_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "role_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_role_assignment();
--> statement-breakpoint
-- a config version for an agent artifact becoming active is a publish
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_config_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark(NEW."artifact_id", NULL, 'published');
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "config_versions_risk_mark_insert" ON "config_versions";
--> statement-breakpoint
CREATE TRIGGER "config_versions_risk_mark_insert" AFTER INSERT ON "config_versions"
  FOR EACH ROW WHEN (NEW."status" = 'active' AND NEW."artifact_type" IN ('agent_config', 'agent_system_prompt'))
  EXECUTE FUNCTION public.regulait_agent_risk_on_config_version();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "config_versions_risk_mark_update" ON "config_versions";
--> statement-breakpoint
CREATE TRIGGER "config_versions_risk_mark_update" AFTER UPDATE OF "status" ON "config_versions"
  FOR EACH ROW WHEN (NEW."status" = 'active' AND OLD."status" IS DISTINCT FROM 'active'
                     AND NEW."artifact_type" IN ('agent_config', 'agent_system_prompt'))
  EXECUTE FUNCTION public.regulait_agent_risk_on_config_version();
--> statement-breakpoint
-- every agent is scored once by the first sweep (a first load, ADR-0180: no agent is grandfathered unscored)
INSERT INTO "agent_risk_recompute_requests" ("agent_id", "trigger")
  SELECT "id", 'backfill' FROM "agents"
  ON CONFLICT ("agent_id", "trigger") WHERE "agent_id" IS NOT NULL DO NOTHING;
--> statement-breakpoint
INSERT INTO "agent_risk_recompute_requests" ("builder_agent_id", "trigger")
  SELECT "id", 'backfill' FROM "builder_agents" WHERE "archived_at" IS NULL
  ON CONFLICT ("builder_agent_id", "trigger") WHERE "builder_agent_id" IS NOT NULL DO NOTHING;
