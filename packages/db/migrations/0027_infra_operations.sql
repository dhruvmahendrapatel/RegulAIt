-- PILLAR 3 (§8.2): the governed infrastructure-operations layer. Monitored
-- resources + operational policies + detected findings + governed remediation.
-- Findings are inert reports; a remediation is a governed action (auto under
-- policy, or approval-gated) that runs strictly after the governance decision.
-- Enum extensions to approvals.object_type / audit_log.object_type are TS-only
-- (no DB CHECK, per the codebase pattern) — nothing to alter here for those.

-- §8.3 -> §8.2 tie: a framework profile can now declare an infra floor. Existing
-- rows backfill null (no floor of their own).
ALTER TABLE "compliance_profiles" ADD COLUMN "backup_retention_days" integer;--> statement-breakpoint
ALTER TABLE "compliance_profiles" ADD COLUMN "patch_cadence_days" integer;--> statement-breakpoint

CREATE TABLE "infra_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'mock' NOT NULL,
	"config" jsonb,
	"classifications" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_resources_name_unique" UNIQUE("name")
);--> statement-breakpoint

CREATE TABLE "infra_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid,
	"patch_cadence_days" integer,
	"cert_rotation_days_before_expiry" integer,
	"backup_schedule" text,
	"backup_retention_days" integer,
	"drift_baseline" jsonb,
	"auto_remediate_max_severity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "infra_policies" ADD CONSTRAINT "infra_policies_resource_id_infra_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_policies_resource_idx" ON "infra_policies" USING btree ("resource_id");--> statement-breakpoint

CREATE TABLE "infra_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"detail" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "infra_findings" ADD CONSTRAINT "infra_findings_resource_id_infra_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_findings_resource_idx" ON "infra_findings" USING btree ("resource_id");--> statement-breakpoint
-- Natural-key uniqueness so a re-scan is idempotent: scanning twice refreshes
-- detected_at rather than duplicating the same open finding.
CREATE UNIQUE INDEX "infra_findings_natural_key_uq" ON "infra_findings" USING btree ("resource_id","kind",("detail"->>'signature'));
