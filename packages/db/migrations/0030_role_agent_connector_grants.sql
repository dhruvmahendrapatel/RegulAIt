CREATE TABLE "role_agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"allowed_modes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_connector_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"allowed_objects" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_agent_grants" ADD CONSTRAINT "role_agent_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_agent_grants" ADD CONSTRAINT "role_agent_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_connector_grants" ADD CONSTRAINT "role_connector_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_connector_grants" ADD CONSTRAINT "role_connector_grants_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "role_agent_grants_role_agent_uq" ON "role_agent_grants" USING btree ("role_id","agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "role_connector_grants_role_connector_uq" ON "role_connector_grants" USING btree ("role_id","connector_id");
