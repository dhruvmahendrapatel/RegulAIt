-- ADR-0182 (ADR-0175 batch D4) — accountability records, P0 foundation.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785097000000.
-- 0065, 0147 and 0152 are retired numbers.
--
-- New tables (CHECKs mirror the vocabularies in packages/shared/src/accountability.ts):
--   governance_review_policy_versions   A11  append-only; v1 backfilled from the live policy
--   use_case_decision_records           A11  append-only: one row per terminal sign-off decision
--   decision_regression_cases / _runs   A11  the golden set's overrides and every run
--   ai_incidents (+ events, links,      A12  the incident register; events are an append-only
--     actions, notifications)                timeline and a notification clock is never deleted
--   use_case_feedback (+ _links)        A13  problem reports and appeals; bodies are ciphertext
--   ai_policy_documents (+ _acks)       A14  versioned AI policies and trainings, acknowledgements
-- New columns:
--   governance_review_policy.version, ai_use_cases.eu_ai_act_role (default 'both'),
--   governance_alerts owner / due / SLA breach (S5, PF-14), kris.on_breach (S5, PF-03),
--   and thirteen org_settings columns, each with its STRICT default.
-- Widened CHECKs: remediation_proposals.kind (+ halt_agent, S5) and
--   use_case_conditions.metric (+ user_report_rate, appeal_overturn_rate, A13).
--
-- SECURE BY DEFAULT, NO GRANDFATHERING (ADR-0180 §1, ADR-0181). Every new
-- setting column carries its strict default, so `ADD COLUMN … DEFAULT` writes
-- the strict value onto the existing org_settings row exactly as on a first
-- load; existing use cases take `both`; an existing agent-scoped high-severity
-- KRI takes `propose_halt` (a SUGGESTION on its breach episode, owner decision
-- 4: nothing is filed or halted automatically). Each change to existing
-- records leaves an audit row through migration_audit_outbox (ADR-0181 FX2).
--
-- APPEND-ONLY TABLES. `regulait_refuse_mutation()` refuses a direct UPDATE or
-- DELETE. It admits exactly one path: a referential action (ON DELETE CASCADE
-- of a parent, ON DELETE SET NULL of an actor) runs from inside the FK's own
-- trigger, at trigger depth > 1, so deleting a test user or a use case still
-- works while no statement can edit or remove a record directly. Like every
-- application-layer control here, a superuser can disable the trigger.

CREATE OR REPLACE FUNCTION "regulait_refuse_mutation"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    -- a referential action of a parent's deletion (cascade / set null)
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'records here are evidence; write a new row instead (ADR-0182)';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- ADR-0060's canonical JSON, in SQL, for the digest of the backfilled v1
-- review policy. Keys sorted (byte order = code-point order; the bodies here
-- have ASCII keys), no whitespace, scalars as jsonb prints them (which is
-- JSON.stringify's form for strings and for numbers the application wrote).
-- The shared `accountabilityDigest` computes the same value; a test pins that.
CREATE OR REPLACE FUNCTION "regulait_canonical_json"(j jsonb) RETURNS text AS $$
DECLARE
  out text;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_json(k)::text || ':' || "regulait_canonical_json"(v), ',' ORDER BY k COLLATE "C"), '') || '}'
        INTO out FROM jsonb_each(j) AS e(k, v);
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg("regulait_canonical_json"(v), ',' ORDER BY i), '') || ']'
        INTO out FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, i);
    ELSE
      out := j::text;
  END CASE;
  RETURN out;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

-- ===== A11: review policy versions, decision records, regression ===========
ALTER TABLE "governance_review_policy" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "governance_review_policy" ADD CONSTRAINT "governance_review_policy_version_check" CHECK ("version" >= 1);
--> statement-breakpoint
CREATE TABLE "governance_review_policy_versions" (
  "version" integer PRIMARY KEY NOT NULL,
  "body" jsonb NOT NULL,
  "digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "governance_review_policy_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "governance_review_policy_versions_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TRIGGER "governance_review_policy_versions_append_only"
  BEFORE UPDATE OR DELETE ON "governance_review_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
INSERT INTO "governance_review_policy_versions" ("version", "body", "digest", "created_at", "created_by")
SELECT 1, b."body", encode(sha256(convert_to("regulait_canonical_json"(b."body"), 'UTF8')), 'hex'), p."updated_at", p."updated_by_user_id"
FROM "governance_review_policy" AS p
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'roles', p."roles",
    'tiers', p."tiers",
    'riskAcceptorUserIds', p."risk_acceptor_user_ids",
    'requiredTests', p."required_tests"
  ) AS "body"
) AS b
WHERE p."id" = 'default';
--> statement-breakpoint
CREATE TABLE "use_case_decision_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "use_case_id" uuid NOT NULL REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "workflow_instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "review_policy_version" integer,
  "required_tests_digest" text,
  "intake_template_id" uuid REFERENCES "workflow_templates"("id") ON DELETE SET NULL,
  "intake_template_name" text,
  "intake_definition_digest" text,
  "eu_ai_act_ruleset_version" integer,
  "intake_assist_version" text,
  "answers_digest" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "use_case_decision_records_outcome_check" CHECK ("outcome" IN ('approved', 'rejected', 'needs_info'))
);
--> statement-breakpoint
CREATE INDEX "use_case_decision_records_use_case_idx" ON "use_case_decision_records" ("use_case_id", "decided_at");
--> statement-breakpoint
CREATE TRIGGER "use_case_decision_records_append_only"
  BEFORE UPDATE OR DELETE ON "use_case_decision_records"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
CREATE TABLE "decision_regression_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "label" text NOT NULL,
  "answers" jsonb NOT NULL,
  "expected" jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "from_use_case_id" uuid REFERENCES "ai_use_cases"("id") ON DELETE SET NULL,
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_regression_cases_source_check" CHECK ("source" IN ('shipped', 'override')),
  CONSTRAINT "decision_regression_cases_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "decision_regression_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger" text NOT NULL,
  "subject" text NOT NULL,
  "candidate_digest" text NOT NULL,
  "baseline_digest" text,
  "cases" integer NOT NULL,
  "changed" integer NOT NULL,
  "diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_regression_runs_trigger_check" CHECK ("trigger" IN ('ci', 'preview', 'activation')),
  CONSTRAINT "decision_regression_runs_subject_check" CHECK ("subject" IN ('review_policy', 'required_tests', 'intake_template')),
  CONSTRAINT "decision_regression_runs_counts_check" CHECK ("cases" >= 0 AND "changed" >= 0 AND "changed" <= "cases")
);
--> statement-breakpoint
CREATE INDEX "decision_regression_runs_digest_idx" ON "decision_regression_runs" ("candidate_digest", "created_at");
--> statement-breakpoint

-- ===== A12: the AI incident register =======================================
CREATE SEQUENCE "ai_incident_ref_seq";
--> statement-breakpoint
CREATE TABLE "ai_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ref" text DEFAULT ('INC-' || lpad(nextval('ai_incident_ref_seq')::text, 5, '0')) NOT NULL,
  "title" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "severity" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "detection_source" text NOT NULL,
  "source_ref" text,
  "occurred_at" timestamp with time zone,
  "aware_at" timestamp with time zone NOT NULL,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "use_case_id" uuid REFERENCES "ai_use_cases"("id") ON DELETE SET NULL,
  "serious" boolean DEFAULT false NOT NULL,
  "serious_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "phi_individuals" integer,
  "root_cause" text,
  "lessons_learned" text,
  "closed_at" timestamp with time zone,
  "closed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_incidents_ref_uq" UNIQUE ("ref"),
  CONSTRAINT "ai_incidents_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "ai_incidents_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "ai_incidents_status_check" CHECK ("status" IN ('open', 'contained', 'resolved', 'closed')),
  CONSTRAINT "ai_incidents_detection_source_check" CHECK ("detection_source" IN ('monitor_alert', 'trace_evaluation', 'user_report', 'red_team', 'manual', 'external')),
  CONSTRAINT "ai_incidents_serious_criteria_check" CHECK (
    jsonb_typeof("serious_criteria") = 'array'
    AND "serious_criteria" <@ '["death", "health", "critical_infrastructure", "fundamental_rights", "property_environment", "widespread_infringement", "phi_breach"]'::jsonb
  ),
  CONSTRAINT "ai_incidents_phi_individuals_check" CHECK (
    "phi_individuals" IS NULL OR ("phi_individuals" >= 0 AND "serious_criteria" ? 'phi_breach')
  ),
  -- closing records why it happened and what was learned, and when
  CONSTRAINT "ai_incidents_closed_check" CHECK (
    ("status" = 'closed') = ("closed_at" IS NOT NULL)
    AND ("status" <> 'closed' OR (length(btrim(COALESCE("root_cause", ''))) > 0 AND length(btrim(COALESCE("lessons_learned", ''))) > 0))
  )
);
--> statement-breakpoint
ALTER SEQUENCE "ai_incident_ref_seq" OWNED BY "ai_incidents"."ref";
--> statement-breakpoint
CREATE INDEX "ai_incidents_status_idx" ON "ai_incidents" ("status", "severity");
--> statement-breakpoint
CREATE INDEX "ai_incidents_use_case_idx" ON "ai_incidents" ("use_case_id") WHERE "use_case_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ai_incidents_owner_idx" ON "ai_incidents" ("owner_user_id") WHERE "owner_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "ai_incident_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "incident_id" uuid NOT NULL REFERENCES "ai_incidents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "note" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "ai_incident_events_kind_check" CHECK ("kind" IN ('note', 'status', 'containment', 'notification', 'link', 'action'))
);
--> statement-breakpoint
CREATE INDEX "ai_incident_events_incident_idx" ON "ai_incident_events" ("incident_id", "at");
--> statement-breakpoint
CREATE TRIGGER "ai_incident_events_append_only"
  BEFORE UPDATE OR DELETE ON "ai_incident_events"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
CREATE TABLE "ai_incident_links" (
  "incident_id" uuid NOT NULL REFERENCES "ai_incidents"("id") ON DELETE CASCADE,
  "object_type" text NOT NULL,
  "object_id" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_incident_links_pk" PRIMARY KEY ("incident_id", "object_type", "object_id"),
  CONSTRAINT "ai_incident_links_object_type_check" CHECK ("object_type" IN ('agent', 'model', 'vendor', 'risk', 'condition', 'eval_run', 'redteam_run', 'governance_alert', 'feedback', 'pm_link')),
  CONSTRAINT "ai_incident_links_object_id_check" CHECK (length(btrim("object_id")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "ai_incident_links_object_idx" ON "ai_incident_links" ("object_type", "object_id");
--> statement-breakpoint
CREATE TABLE "ai_incident_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "incident_id" uuid NOT NULL REFERENCES "ai_incidents"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "due_at" timestamp with time zone,
  "status" text DEFAULT 'open' NOT NULL,
  "done_at" timestamp with time zone,
  "evidence_ref" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_incident_actions_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 500),
  CONSTRAINT "ai_incident_actions_status_check" CHECK ("status" IN ('open', 'done', 'cancelled')),
  CONSTRAINT "ai_incident_actions_done_check" CHECK (("status" = 'done') = ("done_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "ai_incident_actions_incident_idx" ON "ai_incident_actions" ("incident_id");
--> statement-breakpoint
CREATE INDEX "ai_incident_actions_due_idx" ON "ai_incident_actions" ("due_at") WHERE "status" = 'open';
--> statement-breakpoint
CREATE TABLE "ai_incident_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "incident_id" uuid NOT NULL REFERENCES "ai_incidents"("id") ON DELETE CASCADE,
  "regime" text NOT NULL,
  "clock_id" text NOT NULL,
  "recipient" text,
  "clock_start" timestamp with time zone NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "sent_at" timestamp with time zone,
  "sent_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reference" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_incident_notifications_clock_uq" UNIQUE ("incident_id", "clock_id"),
  CONSTRAINT "ai_incident_notifications_regime_check" CHECK ("regime" IN ('eu-ai-act', 'hipaa')),
  CONSTRAINT "ai_incident_notifications_status_check" CHECK ("status" IN ('pending', 'sent_initial', 'sent_complete', 'not_required', 'tolled')),
  -- a clock is set aside only with a stated reason
  CONSTRAINT "ai_incident_notifications_reason_check" CHECK (
    "status" NOT IN ('not_required', 'tolled') OR length(btrim(COALESCE("reason", ''))) > 0
  ),
  CONSTRAINT "ai_incident_notifications_sent_check" CHECK (
    "status" NOT IN ('sent_initial', 'sent_complete') OR "sent_at" IS NOT NULL
  ),
  CONSTRAINT "ai_incident_notifications_due_check" CHECK ("due_at" >= "clock_start")
);
--> statement-breakpoint
CREATE INDEX "ai_incident_notifications_due_idx" ON "ai_incident_notifications" ("due_at")
  WHERE "status" IN ('pending', 'sent_initial');
--> statement-breakpoint
-- a clock is never deleted: setting one aside is `not_required` / `tolled` with a reason
CREATE TRIGGER "ai_incident_notifications_never_deleted"
  BEFORE DELETE ON "ai_incident_notifications"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint

-- ===== A13: end-user feedback and appeal ===================================
CREATE TABLE "use_case_feedback_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "use_case_id" uuid NOT NULL REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "max_uses" integer NOT NULL,
  "uses" integer DEFAULT 0 NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "use_case_feedback_links_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "use_case_feedback_links_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  -- a public link lives at most 30 days
  CONSTRAINT "use_case_feedback_links_ttl_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '30 days'
  ),
  CONSTRAINT "use_case_feedback_links_uses_check" CHECK (
    "max_uses" BETWEEN 1 AND 10000 AND "uses" >= 0 AND "uses" <= "max_uses"
  )
);
--> statement-breakpoint
CREATE INDEX "use_case_feedback_links_use_case_idx" ON "use_case_feedback_links" ("use_case_id");
--> statement-breakpoint
CREATE TABLE "use_case_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "use_case_id" uuid NOT NULL REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "channel" text NOT NULL,
  "link_id" uuid REFERENCES "use_case_feedback_links"("id") ON DELETE SET NULL,
  "submitter_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "body_ciphertext" text,
  "contact_ciphertext" text,
  "body_purged_at" timestamp with time zone,
  "trace_id" uuid,
  "span_id" uuid,
  "status" text DEFAULT 'received' NOT NULL,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "ack_due_at" timestamp with time zone NOT NULL,
  "resolve_due_at" timestamp with time zone NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolution_note" text,
  "incident_id" uuid REFERENCES "ai_incidents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "use_case_feedback_kind_check" CHECK ("kind" IN ('problem', 'appeal')),
  CONSTRAINT "use_case_feedback_channel_check" CHECK ("channel" IN ('in_app', 'signed_link')),
  CONSTRAINT "use_case_feedback_status_check" CHECK ("status" IN ('received', 'acknowledged', 'in_review', 'upheld', 'overturned', 'no_change', 'rejected')),
  -- upheld / overturned are an appeal's outcomes
  CONSTRAINT "use_case_feedback_appeal_outcome_check" CHECK ("kind" = 'appeal' OR "status" NOT IN ('upheld', 'overturned')),
  CONSTRAINT "use_case_feedback_resolved_check" CHECK (
    "status" NOT IN ('upheld', 'overturned', 'no_change', 'rejected') OR "resolved_at" IS NOT NULL
  ),
  -- the body exists until the retention sweep purges it (with the contact)
  CONSTRAINT "use_case_feedback_body_check" CHECK (
    ("body_ciphertext" IS NULL) = ("body_purged_at" IS NOT NULL)
    AND ("body_purged_at" IS NULL OR "contact_ciphertext" IS NULL)
  ),
  CONSTRAINT "use_case_feedback_due_check" CHECK ("resolve_due_at" >= "ack_due_at")
);
--> statement-breakpoint
CREATE INDEX "use_case_feedback_use_case_idx" ON "use_case_feedback" ("use_case_id", "created_at");
--> statement-breakpoint
CREATE INDEX "use_case_feedback_owner_idx" ON "use_case_feedback" ("owner_user_id", "status");
--> statement-breakpoint
CREATE INDEX "use_case_feedback_open_due_idx" ON "use_case_feedback" ("resolve_due_at")
  WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "use_case_feedback_retention_idx" ON "use_case_feedback" ("created_at")
  WHERE "body_purged_at" IS NULL;
--> statement-breakpoint

-- ===== A14: AI literacy and acceptable-use acknowledgements ================
CREATE TABLE "ai_policy_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "kind" text NOT NULL,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "url" text,
  "attachment_id" uuid,
  "content_digest" text NOT NULL,
  "audience" jsonb DEFAULT '{"all": true, "teamIds": [], "roleIds": []}'::jsonb NOT NULL,
  "validity_days" integer,
  "status" text DEFAULT 'draft' NOT NULL,
  "editorial" boolean DEFAULT false NOT NULL,
  "editorial_reason" text,
  "published_at" timestamp with time zone,
  "published_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "retired_at" timestamp with time zone,
  "retired_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_policy_documents_key_version_uq" UNIQUE ("key", "version"),
  CONSTRAINT "ai_policy_documents_key_check" CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  CONSTRAINT "ai_policy_documents_kind_check" CHECK ("kind" IN ('acceptable_use', 'training')),
  CONSTRAINT "ai_policy_documents_version_check" CHECK ("version" >= 1),
  CONSTRAINT "ai_policy_documents_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "ai_policy_documents_source_check" CHECK ("url" IS NOT NULL OR "attachment_id" IS NOT NULL),
  CONSTRAINT "ai_policy_documents_digest_check" CHECK ("content_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_policy_documents_audience_check" CHECK (jsonb_typeof("audience") = 'object'),
  CONSTRAINT "ai_policy_documents_validity_check" CHECK ("validity_days" IS NULL OR "validity_days" BETWEEN 30 AND 730),
  CONSTRAINT "ai_policy_documents_status_check" CHECK ("status" IN ('draft', 'published', 'retired')),
  CONSTRAINT "ai_policy_documents_published_check" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL),
  CONSTRAINT "ai_policy_documents_retired_check" CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL)),
  -- an editorial version keeps acknowledgements, so it states why (and there must be a prior version)
  CONSTRAINT "ai_policy_documents_editorial_check" CHECK (
    NOT "editorial" OR ("version" > 1 AND length(btrim(COALESCE("editorial_reason", ''))) > 0)
  )
);
--> statement-breakpoint
-- one published version per key
CREATE UNIQUE INDEX "ai_policy_documents_published_uq" ON "ai_policy_documents" ("key") WHERE "status" = 'published';
--> statement-breakpoint
CREATE TABLE "ai_policy_acknowledgements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "ai_policy_documents"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "digest" text NOT NULL,
  "method" text NOT NULL,
  "recorded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "evidence_ref" text,
  "acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "ai_policy_acknowledgements_user_document_uq" UNIQUE ("user_id", "document_id"),
  CONSTRAINT "ai_policy_acknowledgements_method_check" CHECK ("method" IN ('acknowledged', 'training_completed', 'admin_recorded')),
  CONSTRAINT "ai_policy_acknowledgements_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  -- a completion someone else recorded carries its evidence reference
  CONSTRAINT "ai_policy_acknowledgements_evidence_check" CHECK (
    "method" = 'acknowledged' OR length(btrim(COALESCE("evidence_ref", ''))) > 0
  ),
  CONSTRAINT "ai_policy_acknowledgements_expiry_check" CHECK ("expires_at" > "acknowledged_at")
);
--> statement-breakpoint
CREATE INDEX "ai_policy_acknowledgements_document_idx" ON "ai_policy_acknowledgements" ("document_id");
--> statement-breakpoint
CREATE INDEX "ai_policy_acknowledgements_expiry_idx" ON "ai_policy_acknowledgements" ("expires_at");
--> statement-breakpoint

-- ===== existing tables =====================================================
-- owner decision 2: every applicable clock starts unless a role is narrowed
ALTER TABLE "ai_use_cases" ADD COLUMN "eu_ai_act_role" text DEFAULT 'both' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_eu_ai_act_role_check" CHECK ("eu_ai_act_role" IN ('provider', 'deployer', 'both'));
--> statement-breakpoint
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0162_accountability_records',
  'ai_use_case',
  NULL,
  'use-case-eu-ai-act-role-defaulted',
  'Migration 0162 gave ' || count(*) || ' existing use case(s) the EU AI Act role ''both'' (ADR-0182, owner decision 2): ' ||
    'a serious incident starts every applicable notification clock until an admin narrows the role.',
  jsonb_build_object(
    'phase', 'migration-0162',
    'useCases', count(*),
    'transitions', jsonb_build_object('euAiActRole', jsonb_build_object('from', NULL, 'to', 'both'))
  )
FROM "ai_use_cases"
HAVING count(*) > 0;
--> statement-breakpoint
-- S5 (PF-14): alert owner, due time and SLA breach
ALTER TABLE "governance_alerts" ADD COLUMN "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD COLUMN "owner_source" text;
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD COLUMN "due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD COLUMN "sla_breached_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_owner_source_check" CHECK ("owner_source" IS NULL OR "owner_source" IN ('derived', 'assigned'));
--> statement-breakpoint
CREATE INDEX "governance_alerts_sla_due_idx" ON "governance_alerts" ("due_at")
  WHERE "sla_breached_at" IS NULL AND "status" <> 'resolved';
--> statement-breakpoint
-- S5 (PF-03): a KRI breach may SUGGEST a halt; owner decision 4: suggest only
ALTER TABLE "kris" ADD COLUMN "on_breach" text DEFAULT 'alert' NOT NULL;
--> statement-breakpoint
ALTER TABLE "kris" ADD CONSTRAINT "kris_on_breach_check" CHECK ("on_breach" IN ('alert', 'propose_halt'));
--> statement-breakpoint
ALTER TABLE "kris" ADD CONSTRAINT "kris_on_breach_scope_check" CHECK ("on_breach" <> 'propose_halt' OR "scope" = 'agent');
--> statement-breakpoint
WITH "changed" AS (
  UPDATE "kris" SET "on_breach" = 'propose_halt', "updated_at" = now()
  WHERE "scope" = 'agent' AND "severity" = 'high'
  RETURNING "id", "name", "scope_id"
)
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0162_accountability_records',
  'kri',
  "id",
  'kri-on-breach-defaulted',
  'KRI ''' || "name" || ''' (agent-scoped, high severity) now SUGGESTS a halt of its agent when it breaches (migration 0162, ' ||
    'ADR-0182 PF-03). A suggestion only: nothing is filed or halted unless a person files the proposal and a different ' ||
    'person approves it. An admin may set it back to alert.',
  jsonb_build_object(
    'phase', 'migration-0162',
    'agentId', "scope_id",
    'transitions', jsonb_build_object('onBreach', jsonb_build_object('from', 'alert', 'to', 'propose_halt'))
  )
FROM "changed";
--> statement-breakpoint
ALTER TABLE "remediation_proposals" DROP CONSTRAINT "remediation_proposals_kind_check";
--> statement-breakpoint
ALTER TABLE "remediation_proposals" ADD CONSTRAINT "remediation_proposals_kind_check" CHECK ("kind" IN ('link_control', 'assign_agent_owner', 'halt_agent'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" DROP CONSTRAINT "use_case_conditions_metric_check";
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_metric_check" CHECK ("metric" IS NULL OR "metric" IN ('trace_eval_flag_rate', 'guardrail_hits', 'guardrail_mode', 'redteam_asr', 'eval_mean_score', 'eval_pass_rate', 'spend_usd', 'error_rate', 'pack_control_evidenced', 'user_report_rate', 'appeal_overturn_rate'));
--> statement-breakpoint

-- ===== org settings: thirteen D4 settings, each STRICT by default ==========
ALTER TABLE "org_settings" ADD COLUMN "decision_regression_gate" text DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "decision_regression_max_age_minutes" integer DEFAULT 60 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "incident_gate_mode" text DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "incident_evidence_hold" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "incident_clock_regimes" jsonb DEFAULT '["eu-ai-act", "hipaa"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "feedback_signed_links_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "feedback_ack_sla_hours" integer DEFAULT 72 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "feedback_resolve_sla_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "feedback_retention_days" integer DEFAULT 365 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "literacy_gate_mode" text DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "literacy_default_validity_days" integer DEFAULT 365 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "alert_sla_hours" jsonb DEFAULT '{"high": 24, "medium": 72, "low": 168}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "alert_ticket_mode" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_decision_regression_gate_check" CHECK ("decision_regression_gate" IN ('off', 'warn', 'enforce'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_decision_regression_max_age_check" CHECK ("decision_regression_max_age_minutes" BETWEEN 1 AND 1440);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_incident_gate_mode_check" CHECK ("incident_gate_mode" IN ('off', 'warn', 'enforce'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_incident_clock_regimes_check" CHECK (
  jsonb_typeof("incident_clock_regimes") = 'array' AND "incident_clock_regimes" <@ '["eu-ai-act", "hipaa"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_feedback_sla_check" CHECK (
  "feedback_ack_sla_hours" BETWEEN 1 AND 168 AND "feedback_resolve_sla_days" BETWEEN 1 AND 90
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_feedback_retention_check" CHECK ("feedback_retention_days" BETWEEN 30 AND 2555);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_literacy_gate_mode_check" CHECK ("literacy_gate_mode" IN ('off', 'warn', 'enforce'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_literacy_validity_check" CHECK ("literacy_default_validity_days" BETWEEN 30 AND 730);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_alert_sla_hours_check" CHECK (
  jsonb_typeof("alert_sla_hours") = 'object'
  AND jsonb_typeof("alert_sla_hours" -> 'high') = 'number'
  AND jsonb_typeof("alert_sla_hours" -> 'medium') = 'number'
  AND jsonb_typeof("alert_sla_hours" -> 'low') = 'number'
  AND ("alert_sla_hours" ->> 'high')::numeric BETWEEN 1 AND 720
  AND ("alert_sla_hours" ->> 'medium')::numeric BETWEEN 1 AND 720
  AND ("alert_sla_hours" ->> 'low')::numeric BETWEEN 1 AND 720
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_alert_ticket_mode_check" CHECK ("alert_ticket_mode" IN ('manual', 'auto_high'));
--> statement-breakpoint
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0162_accountability_records',
  'org_settings',
  NULL,
  'accountability-settings-strict',
  'Migration 0162 introduced the ADR-0182 accountability settings at their STRICT values on the existing org settings ' ||
    '(no grandfathering): decision regression gate enforce (60 min), incident gate enforce, evidence hold on, both ' ||
    'incident clock regimes, public feedback links off, feedback response 72 h / 30 d, feedback retention 365 d, ' ||
    'literacy gate enforce (365 d), alert SLA 24/72/168 h, alert tickets manual. An admin may relax each one (audited).',
  jsonb_build_object(
    'phase', 'migration-0162',
    'settings', jsonb_build_object(
      'decisionRegressionGate', "decision_regression_gate",
      'decisionRegressionMaxAgeMinutes', "decision_regression_max_age_minutes",
      'incidentGateMode', "incident_gate_mode",
      'incidentEvidenceHold', "incident_evidence_hold",
      'incidentClockRegimes', "incident_clock_regimes",
      'feedbackSignedLinksEnabled', "feedback_signed_links_enabled",
      'feedbackAckSlaHours', "feedback_ack_sla_hours",
      'feedbackResolveSlaDays', "feedback_resolve_sla_days",
      'feedbackRetentionDays', "feedback_retention_days",
      'literacyGateMode', "literacy_gate_mode",
      'literacyDefaultValidityDays', "literacy_default_validity_days",
      'alertSlaHours', "alert_sla_hours",
      'alertTicketMode', "alert_ticket_mode"
    )
  )
FROM "org_settings";
