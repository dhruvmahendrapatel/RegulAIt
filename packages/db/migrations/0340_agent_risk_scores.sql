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
    CHECK ("trigger" IN ('created', 'modified', 'published', 'access_changed', 'evidence_changed', 'imported', 'backfill', 'scheduled', 'manual'))
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
    cardinality("triggers") BETWEEN 1 AND 9
    AND "triggers" <@ ARRAY['created', 'modified', 'published', 'access_changed', 'evidence_changed', 'imported', 'backfill', 'scheduled', 'manual']::text[]
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
--> statement-breakpoint
-- ===== review round 1 (#883): the score's other inputs mark too, and the ranked list reads a latest pointer =====
-- An input that is not the agent row itself changed: every agent whose score reads it is marked `evidence_changed`,
-- in the change's own transaction, so the admin ranking never waits for an unrelated agent edit.
-- a registry agent and every live builder agent bound to it as its model (they inherit its evidence)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_mark_model(p_agent uuid, p_trigger text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b record;
BEGIN
  IF p_agent IS NULL THEN RETURN; END IF;
  PERFORM public.regulait_agent_risk_mark(p_agent, NULL, p_trigger);
  FOR b IN SELECT ba."id" FROM public.builder_agents ba WHERE ba."model_agent_id" = p_agent AND ba."archived_at" IS NULL LOOP
    PERFORM public.regulait_agent_risk_mark(NULL, b."id", p_trigger);
  END LOOP;
END $$;
--> statement-breakpoint
-- every agent and live builder agent: an org-wide input changed (the org guardrail row, an SoD rule) or the daily mark
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_mark_all(p_trigger text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.agent_risk_recompute_requests ("agent_id", "trigger")
    SELECT a."id", p_trigger FROM public.agents a
    ON CONFLICT ("agent_id", "trigger") WHERE "agent_id" IS NOT NULL DO UPDATE SET "requested_at" = now();
  INSERT INTO public.agent_risk_recompute_requests ("builder_agent_id", "trigger")
    SELECT b."id", p_trigger FROM public.builder_agents b WHERE b."archived_at" IS NULL
    ON CONFLICT ("builder_agent_id", "trigger") WHERE "builder_agent_id" IS NOT NULL DO UPDATE SET "requested_at" = now();
END $$;
--> statement-breakpoint
-- guardrail modes: the org row marks everyone; an agent override marks that agent (connector scope is not an input)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_guardrail_config() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (to_jsonb(OLD)), (to_jsonb(NEW))) v(j) WHERE v.j IS NOT NULL LOOP
    IF r.j ->> 'scope' = 'org' THEN
      PERFORM public.regulait_agent_risk_mark_all('evidence_changed');
      RETURN NULL;
    ELSIF r.j ->> 'scope' = 'agent' THEN
      PERFORM public.regulait_agent_risk_mark_model((r.j ->> 'scope_id')::uuid, 'evidence_changed');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "guardrail_configs_risk_mark" ON "guardrail_configs";
--> statement-breakpoint
CREATE TRIGGER "guardrail_configs_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "guardrail_configs"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_guardrail_config();
--> statement-breakpoint
-- a model card: the agent it describes, or every agent served by the custom provider it describes
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_mark_card_subject(p_agent uuid, p_provider uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a record;
BEGIN
  PERFORM public.regulait_agent_risk_mark_model(p_agent, 'evidence_changed');
  IF p_provider IS NOT NULL THEN
    FOR a IN SELECT ag."id" FROM public.agents ag WHERE ag."custom_provider_id" = p_provider LOOP
      PERFORM public.regulait_agent_risk_mark_model(a."id", 'evidence_changed');
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_model_card() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (to_jsonb(OLD)), (to_jsonb(NEW))) v(j) WHERE v.j IS NOT NULL LOOP
    PERFORM public.regulait_agent_risk_mark_card_subject((r.j ->> 'agent_id')::uuid, (r.j ->> 'custom_provider_id')::uuid);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "model_cards_risk_mark" ON "model_cards";
--> statement-breakpoint
CREATE TRIGGER "model_cards_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "model_cards"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_model_card();
--> statement-breakpoint
-- a sign-off on a card (requested, decided, revoked, superseded): the card's subject
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_model_card_approval() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT mc."agent_id", mc."custom_provider_id" FROM public.model_cards mc
    WHERE mc."id" IN ((to_jsonb(OLD) ->> 'card_id')::uuid, (to_jsonb(NEW) ->> 'card_id')::uuid)
  LOOP
    PERFORM public.regulait_agent_risk_mark_card_subject(c."agent_id", c."custom_provider_id");
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "model_card_approvals_risk_mark" ON "model_card_approvals";
--> statement-breakpoint
CREATE TRIGGER "model_card_approvals_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "model_card_approvals"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_model_card_approval();
--> statement-breakpoint
-- a red-team run finishing (or its class summary landing) is new evidence for the agent it probed
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_redteam_run() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark_model(NEW."agent_id", 'evidence_changed');
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "redteam_runs_risk_mark_insert" ON "redteam_runs";
--> statement-breakpoint
CREATE TRIGGER "redteam_runs_risk_mark_insert" AFTER INSERT ON "redteam_runs"
  FOR EACH ROW WHEN (NEW."finished_at" IS NOT NULL) EXECUTE FUNCTION public.regulait_agent_risk_on_redteam_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "redteam_runs_risk_mark_update" ON "redteam_runs";
--> statement-breakpoint
CREATE TRIGGER "redteam_runs_risk_mark_update" AFTER UPDATE OF "finished_at", "class_summary", "agent_id" ON "redteam_runs"
  FOR EACH ROW WHEN (NEW."finished_at" IS NOT NULL AND (OLD."finished_at", OLD."class_summary", OLD."agent_id")
                     IS DISTINCT FROM (NEW."finished_at", NEW."class_summary", NEW."agent_id"))
  EXECUTE FUNCTION public.regulait_agent_risk_on_redteam_run();
--> statement-breakpoint
-- an SoD rule or one of its sides: who holds a rule alone can change for any agent, so every agent (once per statement)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_org_input() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark_all('evidence_changed');
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sod_rules_risk_mark" ON "sod_rules";
--> statement-breakpoint
CREATE TRIGGER "sod_rules_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "sod_rules"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_agent_risk_on_org_input();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sod_rule_sides_risk_mark" ON "sod_rule_sides";
--> statement-breakpoint
CREATE TRIGGER "sod_rule_sides_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "sod_rule_sides"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_agent_risk_on_org_input();
--> statement-breakpoint
-- a user disabled or re-enabled: the agents they own (ownership) and the agents they can use (reach)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_user() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT a."id" FROM public.agents a WHERE a."owner_user_id" = NEW."id"
    UNION SELECT g."agent_id" FROM public.agent_grants g WHERE g."user_id" = NEW."id"
    UNION SELECT rag."agent_id" FROM public.role_agent_grants rag
          JOIN public.role_assignments ra ON ra."role_id" = rag."role_id" WHERE ra."user_id" = NEW."id"
  LOOP
    PERFORM public.regulait_agent_risk_mark(r."id", NULL, 'evidence_changed');
  END LOOP;
  FOR r IN
    SELECT b."id" FROM public.builder_agents b
    WHERE b."archived_at" IS NULL
      AND (b."owner_user_id" = NEW."id" OR b."sharing" = 'workspace'
           OR EXISTS (SELECT 1 FROM public.builder_agent_shares s WHERE s."agent_id" = b."id" AND s."user_id" = NEW."id"))
  LOOP
    PERFORM public.regulait_agent_risk_mark(NULL, r."id", 'evidence_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_risk_mark" ON "users";
--> statement-breakpoint
CREATE TRIGGER "users_risk_mark" AFTER UPDATE OF "disabled_at" ON "users"
  FOR EACH ROW WHEN ((OLD."disabled_at" IS NULL) IS DISTINCT FROM (NEW."disabled_at" IS NULL))
  EXECUTE FUNCTION public.regulait_agent_risk_on_user();
--> statement-breakpoint
-- a skill's admission changing: the builder agents that carry it
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_builder_skill() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT s."agent_id" FROM public.builder_agent_skills s WHERE s."skill_id" = NEW."id" LOOP
    PERFORM public.regulait_agent_risk_mark(NULL, r."agent_id", 'evidence_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_skills_risk_mark" ON "builder_skills";
--> statement-breakpoint
CREATE TRIGGER "builder_skills_risk_mark" AFTER UPDATE OF "admission_state" ON "builder_skills"
  FOR EACH ROW WHEN (OLD."admission_state" IS DISTINCT FROM NEW."admission_state")
  EXECUTE FUNCTION public.regulait_agent_risk_on_builder_skill();
--> statement-breakpoint
-- an MCP tool renamed or moved to another server: the builder agents bound to it (their SoD capability set)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_mcp_tool() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t."agent_id" FROM public.builder_agent_tools t WHERE t."kind" = 'mcp_tool' AND t."ref_id" = OLD."id" LOOP
    PERFORM public.regulait_agent_risk_mark(NULL, r."agent_id", 'evidence_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_tools_risk_mark" ON "mcp_tools";
--> statement-breakpoint
CREATE TRIGGER "mcp_tools_risk_mark" AFTER UPDATE OF "server_id", "name" OR DELETE ON "mcp_tools"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_mcp_tool();
--> statement-breakpoint
-- a use case that intends an agent is a dependent (reach): the agents named before and after
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_use_case() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT x.id FROM (
      SELECT jsonb_array_elements_text(COALESCE(to_jsonb(OLD) -> 'intended_agent_ids', '[]'::jsonb)) AS id
      UNION ALL SELECT jsonb_array_elements_text(COALESCE(to_jsonb(NEW) -> 'intended_agent_ids', '[]'::jsonb))
    ) x WHERE x.id ~ '^[0-9a-f-]{36}$'
  LOOP
    PERFORM public.regulait_agent_risk_mark(r.id::uuid, NULL, 'access_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_use_cases_risk_mark" ON "ai_use_cases";
--> statement-breakpoint
CREATE TRIGGER "ai_use_cases_risk_mark" AFTER INSERT OR UPDATE OF "intended_agent_ids" OR DELETE ON "ai_use_cases"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_use_case();
--> statement-breakpoint
-- a sub-agent link is a dependent of the child (its reach), not only a change to the parent
DROP TRIGGER IF EXISTS "builder_agent_subagents_child_risk_mark" ON "builder_agent_subagents";
--> statement-breakpoint
CREATE TRIGGER "builder_agent_subagents_child_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "builder_agent_subagents"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_builder_part('child_id', 'access_changed');
--> statement-breakpoint
-- a builder agent bound to a model, unbound or archived changes the model agent's dependents (its reach)
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_builder_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark((to_jsonb(NEW) ->> 'model_agent_id')::uuid, NULL, 'access_changed');
  IF TG_OP = 'UPDATE' AND OLD."model_agent_id" IS DISTINCT FROM NEW."model_agent_id" THEN
    PERFORM public.regulait_agent_risk_mark(OLD."model_agent_id", NULL, 'access_changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agents_binding_risk_mark_insert" ON "builder_agents";
--> statement-breakpoint
CREATE TRIGGER "builder_agents_binding_risk_mark_insert" AFTER INSERT ON "builder_agents"
  FOR EACH ROW WHEN (NEW."model_agent_id" IS NOT NULL) EXECUTE FUNCTION public.regulait_agent_risk_on_builder_binding();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "builder_agents_binding_risk_mark_update" ON "builder_agents";
--> statement-breakpoint
CREATE TRIGGER "builder_agents_binding_risk_mark_update" AFTER UPDATE OF "model_agent_id", "archived_at" ON "builder_agents"
  FOR EACH ROW WHEN ((OLD."model_agent_id", OLD."archived_at" IS NULL) IS DISTINCT FROM (NEW."model_agent_id", NEW."archived_at" IS NULL))
  EXECUTE FUNCTION public.regulait_agent_risk_on_builder_binding();
--> statement-breakpoint
-- The ranked list's read path: one pointer per agent to its newest assessment, kept by the database on every append,
-- so the list reads one row per agent instead of sorting the whole append-only history. Third normal form: it holds
-- only references; the score and band are read through the pointer.
CREATE TABLE IF NOT EXISTS "agent_risk_latest" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "builder_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "assessment_id" uuid NOT NULL REFERENCES "agent_risk_assessments"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_risk_latest_subject_check" CHECK (num_nonnulls("agent_id", "builder_agent_id") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_risk_latest_agent_uq" ON "agent_risk_latest" ("agent_id") WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_risk_latest_builder_uq" ON "agent_risk_latest" ("builder_agent_id") WHERE "builder_agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_risk_latest_assessment_uq" ON "agent_risk_latest" ("assessment_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_latest_on_assessment() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- only ever moves forward: a slower concurrent append never replaces a newer pointer
  IF NEW."agent_id" IS NOT NULL THEN
    INSERT INTO public.agent_risk_latest ("agent_id", "assessment_id") VALUES (NEW."agent_id", NEW."id")
      ON CONFLICT ("agent_id") WHERE "agent_id" IS NOT NULL DO UPDATE SET "assessment_id" = EXCLUDED."assessment_id"
      WHERE (SELECT (p."computed_at", p."id") FROM public.agent_risk_assessments p WHERE p."id" = public.agent_risk_latest."assessment_id")
            < (NEW."computed_at", NEW."id");
  ELSE
    INSERT INTO public.agent_risk_latest ("builder_agent_id", "assessment_id") VALUES (NEW."builder_agent_id", NEW."id")
      ON CONFLICT ("builder_agent_id") WHERE "builder_agent_id" IS NOT NULL DO UPDATE SET "assessment_id" = EXCLUDED."assessment_id"
      WHERE (SELECT (p."computed_at", p."id") FROM public.agent_risk_assessments p WHERE p."id" = public.agent_risk_latest."assessment_id")
            < (NEW."computed_at", NEW."id");
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_risk_assessments_latest" ON "agent_risk_assessments";
--> statement-breakpoint
CREATE TRIGGER "agent_risk_assessments_latest" AFTER INSERT ON "agent_risk_assessments"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_latest_on_assessment();
--> statement-breakpoint
-- an install that already holds assessments (a re-run of this file): point at each agent's newest
INSERT INTO "agent_risk_latest" ("agent_id", "assessment_id")
  SELECT DISTINCT ON ("agent_id") "agent_id", "id" FROM "agent_risk_assessments" WHERE "agent_id" IS NOT NULL
  ORDER BY "agent_id", "computed_at" DESC, "id" DESC
  ON CONFLICT ("agent_id") WHERE "agent_id" IS NOT NULL DO NOTHING;
--> statement-breakpoint
INSERT INTO "agent_risk_latest" ("builder_agent_id", "assessment_id")
  SELECT DISTINCT ON ("builder_agent_id") "builder_agent_id", "id" FROM "agent_risk_assessments" WHERE "builder_agent_id" IS NOT NULL
  ORDER BY "builder_agent_id", "computed_at" DESC, "id" DESC
  ON CONFLICT ("builder_agent_id") WHERE "builder_agent_id" IS NOT NULL DO NOTHING;
