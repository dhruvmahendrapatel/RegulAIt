ALTER TABLE "audit_log" ALTER COLUMN "server_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "tool_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "object_type" text DEFAULT 'mcp_tool' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "object_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "detail" jsonb;
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"tier" integer NOT NULL,
	"modes" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"allowed_modes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_agent_policies" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"default_agent_id" uuid,
	"ceiling_agent_id" uuid
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "connector_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"allowed_objects" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_agent_policies" ADD CONSTRAINT "user_agent_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_agent_policies" ADD CONSTRAINT "user_agent_policies_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_agent_policies" ADD CONSTRAINT "user_agent_policies_ceiling_agent_id_agents_id_fk" FOREIGN KEY ("ceiling_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_user_agent_uq" ON "agent_grants" USING btree ("user_id","agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_grants_user_connector_uq" ON "connector_grants" USING btree ("user_id","connector_id");
