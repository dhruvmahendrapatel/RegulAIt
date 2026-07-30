-- ADR-0017 — infra-ops automation ledgers (pillar 3 §8.2 automation depth).
-- Durable domain records (cert inventory + rotations, patch records, backup
-- runs) hang off infra_resources and link back to the inert infra_findings
-- alert surface via ref_table/ref_id. Remediation still flows through the ONE
-- Approvals Queue (objectType 'infra_operation') via an action-tagged sentinel
-- — no new decision path, no new approvals/audit object_type value.

-- A monitored resource MAY live in a customer-hosted deploy target; an
-- air_gapped target forces metadata-only remediation records (ADR-0015 data
-- boundary). ON DELETE SET NULL: dropping a target never deletes the resource.
ALTER TABLE "infra_resources" ADD COLUMN "deploy_target_id" uuid;--> statement-breakpoint

-- A finding stays the single inert alert surface but now links to its durable
-- ledger row (FK-less soft link). null for drift, which has no ledger.
ALTER TABLE "infra_findings" ADD COLUMN "ref_table" text;--> statement-breakpoint
ALTER TABLE "infra_findings" ADD COLUMN "ref_id" uuid;--> statement-breakpoint

CREATE TABLE "cert_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"common_name" text NOT NULL,
	"issuer" text,
	"serial" text,
	"not_after" timestamp with time zone NOT NULL,
	"last_rotated_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "cert_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cert_id" uuid NOT NULL,
	"finding_id" uuid,
	"approval_id" uuid,
	"old_serial" text,
	"new_serial" text,
	"new_not_after" timestamp with time zone,
	"status" text DEFAULT 'proposed' NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "patch_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"finding_id" uuid,
	"cve" text NOT NULL,
	"package" text,
	"installed_version" text,
	"fixed_version" text,
	"cvss" numeric,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"patched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"finding_id" uuid,
	"kind" text DEFAULT 'backup' NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_deploy_target_id_deploy_targets_id_fk" FOREIGN KEY ("deploy_target_id") REFERENCES "public"."deploy_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_inventory" ADD CONSTRAINT "cert_inventory_resource_id_infra_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_rotations" ADD CONSTRAINT "cert_rotations_cert_id_cert_inventory_id_fk" FOREIGN KEY ("cert_id") REFERENCES "public"."cert_inventory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_records" ADD CONSTRAINT "patch_records_resource_id_infra_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_resource_id_infra_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "cert_inventory_resource_idx" ON "cert_inventory" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patch_records_resource_cve_uq" ON "patch_records" USING btree ("resource_id","cve");--> statement-breakpoint
CREATE INDEX "backup_runs_resource_idx" ON "backup_runs" USING btree ("resource_id");
