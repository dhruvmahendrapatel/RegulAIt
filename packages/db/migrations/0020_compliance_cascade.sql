ALTER TABLE "projects" ADD COLUMN "classifications" jsonb;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pending_classifications" jsonb;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "default_classifications" jsonb;
--> statement-breakpoint
CREATE TABLE "compliance_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag" text NOT NULL,
	"required_template_ids" jsonb,
	"mcp_default_mode" text DEFAULT 'read_write' NOT NULL,
	"audit_retention_days" integer,
	"pii_mode" text DEFAULT 'log' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_profiles_tag_unique" UNIQUE("tag")
);
