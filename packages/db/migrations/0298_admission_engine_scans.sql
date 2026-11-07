-- ADR-0242 (PENDING P23): the two admission-scan engines (Cisco mcp-scanner and skill-scanner) and the table
-- their verdicts land in.
--
-- 1. `engines.id` and `engines.kind` gain the two engines and their kind (`admission_scan`). The engines are
--    inserted here and kept current by the gateway's manifest sync, OFF (ADR-0187 decision 3), and with no image digest
--    until an image is published, so neither can be enabled yet (secure default).
-- 2. `admission_engine_scans`: one row per engine scan of one admission subject AT ONE DIGEST. The admission
--    gate (mcp-admission.ts, skill-admission.ts) reads the latest row for the subject's CURRENT digest; with the
--    engine on, only a `pass` there admits (fail closed: no row, `unknown` or `fail` hold).
--
-- The subject is a real foreign key, one column per subject kind, exactly one set (third normal form, ADR-0200
-- addendum). A subject's scans go with it (ON DELETE CASCADE): they describe that subject only.
-- No functions and no refusal triggers here (zz-dbguard-0185.test.ts has nothing new to check).

ALTER TABLE "engines" DROP CONSTRAINT "engines_id_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_id_check" CHECK ("id" IN ('promptfoo', 'modelscan', 'garak', 'mcpscanner', 'skillscanner'));
--> statement-breakpoint
ALTER TABLE "engines" DROP CONSTRAINT "engines_kind_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_kind_check" CHECK ("kind" IN ('redteam', 'eval', 'model_scan', 'admission_scan'));
--> statement-breakpoint
-- the rows the gateway's manifest sync keeps current (it never inserts one): off, no digest
INSERT INTO "engines" ("id", "kind", "version", "licence") VALUES
  ('mcpscanner', 'admission_scan', '4.8.7', 'Apache-2.0'),
  ('skillscanner', 'admission_scan', '2.3.2', 'Apache-2.0')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "admission_engine_scans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engine_id" text NOT NULL,
  "mcp_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "builder_skill_id" uuid REFERENCES "builder_skills"("id") ON DELETE CASCADE,
  -- the subject's digest the scan was of: the MCP manifest digest, or the skill's prompt-section digest
  "subject_digest" text NOT NULL,
  "engine_run_id" uuid REFERENCES "engine_runs"("id") ON DELETE SET NULL,
  "engine_version" text NOT NULL,
  -- the sha256 of the rule set the engine reported (null when it failed before reading its rules)
  "rules_sha256" text,
  "verdict" text NOT NULL,
  -- point-in-time evidence (ADR-0200 addendum exception): the counts-only findings of THIS scan, in the
  -- admission vocabulary ({rule, severity, tool, where, count}); never subject text
  "findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admission_engine_scans_engine_check" CHECK ("engine_id" IN ('mcpscanner', 'skillscanner')),
  CONSTRAINT "admission_engine_scans_subject_check" CHECK (
    ("engine_id" = 'mcpscanner' AND "mcp_server_id" IS NOT NULL AND "builder_skill_id" IS NULL)
    OR ("engine_id" = 'skillscanner' AND "builder_skill_id" IS NOT NULL AND "mcp_server_id" IS NULL)
  ),
  CONSTRAINT "admission_engine_scans_digest_check" CHECK ("subject_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admission_engine_scans_rules_check" CHECK ("rules_sha256" IS NULL OR "rules_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admission_engine_scans_verdict_check" CHECK ("verdict" IN ('pass', 'fail', 'unknown')),
  CONSTRAINT "admission_engine_scans_findings_check" CHECK (jsonb_typeof("findings") = 'array'),
  CONSTRAINT "admission_engine_scans_version_check" CHECK (length("engine_version") BETWEEN 1 AND 32)
);
--> statement-breakpoint
-- the gate's read: the latest scan of one subject at one digest
CREATE INDEX "admission_engine_scans_mcp_idx" ON "admission_engine_scans" ("mcp_server_id", "subject_digest", "created_at" DESC) WHERE "mcp_server_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "admission_engine_scans_skill_idx" ON "admission_engine_scans" ("builder_skill_id", "subject_digest", "created_at" DESC) WHERE "builder_skill_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "admission_engine_scans_engine_run_unique" ON "admission_engine_scans" ("engine_run_id") WHERE "engine_run_id" IS NOT NULL;
