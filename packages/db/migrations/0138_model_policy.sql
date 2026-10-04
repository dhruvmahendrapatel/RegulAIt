-- ADR-0173 §3 — the model allow-list matrix.
--
-- One row per (feature, data class): which governed model bindings (agent
-- registry rows) and/or provider kinds a feature may use, and its default
-- binding. data_class NULL = the feature's base rule; a data-class row applies
-- only where the calling surface knows the class, and can only NARROW the base
-- rule (enforced in the shared model-access decision, not here).
--
-- No rows = today's behaviour: every binding the person is entitled to is
-- allowed everywhere. `restricted = false` keeps a default without restricting.
--
-- allowed_agent_ids is a jsonb array of uuids rather than a child table: a
-- deleted binding left in the list matches nothing (it can no longer be
-- dispatched), and the whole policy is replaced in one audited PUT.
CREATE TABLE IF NOT EXISTS "model_policy_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "feature" text NOT NULL,
  "data_class" text,
  "restricted" boolean DEFAULT true NOT NULL,
  "allowed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "allowed_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "default_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_policy_rules_feature_ck"
    CHECK ("feature" IN ('chat', 'builder', 'copilot', 'intake_assist', 'evals', 'orchestration', 'compat')),
  CONSTRAINT "model_policy_rules_data_class_ck"
    CHECK ("data_class" IS NULL OR "data_class" IN ('public', 'internal', 'confidential', 'regulated')),
  CONSTRAINT "model_policy_rules_agent_ids_array_ck" CHECK (jsonb_typeof("allowed_agent_ids") = 'array'),
  CONSTRAINT "model_policy_rules_providers_array_ck" CHECK (jsonb_typeof("allowed_providers") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_policy_rules_feature_class_uq"
  ON "model_policy_rules" ("feature", COALESCE("data_class", ''));
