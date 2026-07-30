CREATE TABLE "agent_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_revocations" ADD CONSTRAINT "agent_revocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_revocations" ADD CONSTRAINT "agent_revocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_revocations" ADD CONSTRAINT "connector_revocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_revocations" ADD CONSTRAINT "connector_revocations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_revocations_user_agent_uq" ON "agent_revocations" USING btree ("user_id","agent_id");
--> statement-breakpoint
CREATE INDEX "agent_revocations_user_idx" ON "agent_revocations" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_revocations_user_connector_uq" ON "connector_revocations" USING btree ("user_id","connector_id");
--> statement-breakpoint
CREATE INDEX "connector_revocations_user_idx" ON "connector_revocations" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "workflow_assignment_rules" ADD COLUMN "data_sensitivity" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "price_per_call_usd" double precision;
