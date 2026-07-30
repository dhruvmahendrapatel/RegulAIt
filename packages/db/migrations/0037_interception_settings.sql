CREATE TABLE "interception_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"anthropic_compat_enabled" boolean DEFAULT false NOT NULL,
	"openai_compat_enabled" boolean DEFAULT false NOT NULL,
	"mcp_interception_enabled" boolean DEFAULT true NOT NULL,
	"resolution_mode" text DEFAULT 'map_by_model' NOT NULL,
	"enforcement_posture" text DEFAULT 'voluntary' NOT NULL,
	"require_project_attribution" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interception_settings_singleton" CHECK ("interception_settings"."id" = 'singleton')
);
--> statement-breakpoint
INSERT INTO "interception_settings" ("id") VALUES ('singleton') ON CONFLICT DO NOTHING;
