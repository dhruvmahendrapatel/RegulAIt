-- ADR-0347: governed agent memory writes, slice 1 (provenance and mandatory expiry).
-- No grandfathering (ADR-0180): rows written before this migration get the strict 24-hour expiry from now.
ALTER TABLE "project_context_items" ADD COLUMN "produced_by_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "project_context_items" ADD COLUMN "produced_by_node_id" text;
--> statement-breakpoint
ALTER TABLE "project_context_items" ADD COLUMN "produced_by_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "project_context_items" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL;
--> statement-breakpoint
CREATE INDEX "project_context_expires_idx" ON "project_context_items" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "builder_agent_memory" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "agent_memory_ttl_hours" integer DEFAULT 24 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_agent_memory_ttl_hours_check" CHECK ("agent_memory_ttl_hours" BETWEEN 1 AND 8760);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "agent_memory_scan_mode" text DEFAULT 'block' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_agent_memory_scan_mode_check" CHECK ("agent_memory_scan_mode" IN ('block', 'log'));
--> statement-breakpoint
ALTER TABLE "compliance_profiles" ADD COLUMN "memory_ttl_hours" integer;
--> statement-breakpoint
ALTER TABLE "compliance_profiles" ADD CONSTRAINT "compliance_profiles_memory_ttl_hours_check" CHECK ("memory_ttl_hours" IS NULL OR "memory_ttl_hours" BETWEEN 1 AND 8760);
