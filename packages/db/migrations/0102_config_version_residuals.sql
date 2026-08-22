-- Batch B7c — ADR-0073's LAST THREE RESIDUALS, the schema half.
--
-- 1. `org_settings.canary_observation_retention_days` — the retention window
--    for `config_canary_observations`, which ADR-0073 disclosed as growing
--    monotonically ("no pruning", disclosure 5). The KNOB defaults generous
--    (90 days); the ADR-0064 job that acts on it inherits the scheduler's own
--    off-by-default posture, so a fresh install still prunes nothing until an
--    operator opts in. ONLY observations are ever pruned — `config_versions`
--    rows are the audit substrate (rollback re-points at them, the activation
--    ledger references them) and are NEVER touched by any retention pass.
--
-- 2. The AFTER DELETE trigger ADR-0074 §5 / the B1 amendment scoped as "its
--    own slice": a config-version SUBJECT row that vanishes through an FK
--    cascade (deleting a user/server/role/team/approver cascades the rule row
--    away with no application code involved) or any raw SQL delete no longer
--    strands its active/canary pointers. The trigger demotes them exactly as
--    the explicit `DELETE /v1/rules/:kind/:ruleId` route does: status
--    'retired', canary_pct nulled, one 'artifact_deleted' entry appended to
--    the activation ledger per pointer. Version rows are KEPT, always.
--
--    The route path is unchanged by construction: `deleteRuleArtifact` demotes
--    the pointers BEFORE deleting the row in the same transaction, so when
--    this trigger fires on the route's own delete there is nothing left in the
--    active/canary space and it does nothing — no double demotion, no
--    duplicate ledger entry.
--
--    The trigger deliberately writes the ACTIVATION LEDGER and NOT audit_log:
--    ADR-0060's hash chain is computed at the application layer (`createDb`),
--    and a trigger-inserted audit row would be un-chained — reported by
--    verification as possible tampering. The activation ledger is the record
--    the versioning surfaces read, and it is what the route writes per
--    pointer too.
--
--    Subject tables = every table whose rows config_versions can point at:
--    the four rule tables (approval_rule, rate_limit, data_scope_rule,
--    compliance_profile) and `agents`, which is the subject of BOTH
--    `agent_config` and `agent_system_prompt` versions — one agents trigger
--    covers both artifact types.
--
-- 3. `usage_events.agent_config_version_id` / `agent_config_version` — the B1
--    amendment's own residual: "usage_events still stamps only the PROMPT
--    version (one stamp column, two artifact types)". The dispatch core now
--    stamps the agent_config version that ACTUALLY SERVED alongside the
--    existing prompt stamp. Mirrors the prompt columns exactly: FK-FREE like
--    every other column of this ledger (a deleted version must not take the
--    spend history's attribution with it), with the integer stored alongside
--    the id so the answer survives a pruned version row. NULL = the agent's
--    config was unversioned (every pre-B7c row, byte-identical). The shadow/
--    canary CANDIDATE id is never stamped here — the column means "what
--    served", and a candidate never serves (ADR-0073's invariant).

ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "canary_observation_retention_days" integer NOT NULL DEFAULT 90;
--> statement-breakpoint
ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "agent_config_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "agent_config_version" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_agent_config_version_idx"
  ON "usage_events" ("agent_config_version_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "config_versions_retire_on_subject_delete"() RETURNS trigger AS $$
DECLARE
  t text;
  v RECORD;
BEGIN
  -- artifact types are trigger arguments, so one function serves every
  -- subject table (agents passes two: agent_config AND agent_system_prompt)
  FOR i IN 0..(TG_NARGS - 1) LOOP
    t := TG_ARGV[i];
    FOR v IN
      SELECT "id", "version", "status", "canary_pct" FROM "config_versions"
      WHERE "artifact_type" = t AND "artifact_id" = OLD."id"
        AND "status" IN ('active', 'canary')
    LOOP
      -- the same demotion the explicit DELETE route performs: 'retired'
      -- (NOT 'superseded', NOT 'rolled_back' — both would misstate history),
      -- canary_pct nulled to satisfy the canary_pct CHECK
      UPDATE "config_versions"
        SET "status" = 'retired', "canary_pct" = NULL
        WHERE "id" = v."id";
      INSERT INTO "config_activation_events"
        ("artifact_type", "artifact_id", "version_id", "version", "action", "actor_user_id", "reason")
      VALUES
        (t, OLD."id", v."id", v."version", 'artifact_deleted', NULL,
         'AFTER DELETE trigger on ' || TG_TABLE_NAME || ': the ' || t || ' this '
           || CASE WHEN v."status" = 'canary'
                THEN 'canary (at ' || COALESCE(v."canary_pct"::text, '?') || '%)'
                ELSE 'active version' END
           || ' belonged to was deleted (FK cascade or raw SQL — not the explicit route) — the '
           || 'version row is kept (status ''retired'') as the record of what governed calls '
           || 'while the artifact existed, and it can never enforce again');
    END LOOP;
  END LOOP;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "approval_rules_retire_config_versions_trg" ON "approval_rules";
--> statement-breakpoint
CREATE TRIGGER "approval_rules_retire_config_versions_trg"
  AFTER DELETE ON "approval_rules"
  FOR EACH ROW EXECUTE FUNCTION "config_versions_retire_on_subject_delete"('approval_rule');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "rate_limits_retire_config_versions_trg" ON "rate_limits";
--> statement-breakpoint
CREATE TRIGGER "rate_limits_retire_config_versions_trg"
  AFTER DELETE ON "rate_limits"
  FOR EACH ROW EXECUTE FUNCTION "config_versions_retire_on_subject_delete"('rate_limit');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "data_scope_rules_retire_config_versions_trg" ON "data_scope_rules";
--> statement-breakpoint
CREATE TRIGGER "data_scope_rules_retire_config_versions_trg"
  AFTER DELETE ON "data_scope_rules"
  FOR EACH ROW EXECUTE FUNCTION "config_versions_retire_on_subject_delete"('data_scope_rule');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "compliance_profiles_retire_config_versions_trg" ON "compliance_profiles";
--> statement-breakpoint
CREATE TRIGGER "compliance_profiles_retire_config_versions_trg"
  AFTER DELETE ON "compliance_profiles"
  FOR EACH ROW EXECUTE FUNCTION "config_versions_retire_on_subject_delete"('compliance_profile');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_retire_config_versions_trg" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "agents_retire_config_versions_trg"
  AFTER DELETE ON "agents"
  FOR EACH ROW EXECUTE FUNCTION "config_versions_retire_on_subject_delete"('agent_config', 'agent_system_prompt');
