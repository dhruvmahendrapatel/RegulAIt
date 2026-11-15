-- ADR-0316 (lane E4, pillar 4): session distillation into the Shared Project context store.
-- The distilled text is an ordinary revision of project_context_items; these tables hold the per-project switch
-- (no row = off, ADR-0180) and the provenance of a distilled revision. Ids marked FK-free in schema.ts are
-- point-in-time evidence that must outlive conversation retention and project deletion.
CREATE TABLE "project_session_distillation_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_session_distillation_policies" ADD CONSTRAINT "project_session_distillation_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_session_distillation_policies" ADD CONSTRAINT "project_session_distillation_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "project_context_distillations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_item_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"distiller_agent_id" uuid NOT NULL,
	"from_message_id" uuid NOT NULL,
	"through_message_id" uuid NOT NULL,
	"session_started_at" timestamp with time zone NOT NULL,
	"session_last_turn_at" timestamp with time zone NOT NULL,
	"distilled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_context_distillations_context_item_id_unique" UNIQUE("context_item_id")
);
--> statement-breakpoint
ALTER TABLE "project_context_distillations" ADD CONSTRAINT "project_context_distillations_context_item_id_project_context_items_id_fk" FOREIGN KEY ("context_item_id") REFERENCES "public"."project_context_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_context_distillations_conversation_idx" ON "project_context_distillations" USING btree ("conversation_id","distilled_at");
--> statement-breakpoint
CREATE TABLE "project_context_distillation_messages" (
	"distillation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	CONSTRAINT "project_context_distillation_messages_pk" PRIMARY KEY("distillation_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "project_context_distillation_messages" ADD CONSTRAINT "project_context_distillation_messages_distillation_id_project_context_distillations_id_fk" FOREIGN KEY ("distillation_id") REFERENCES "public"."project_context_distillations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "project_context_distillation_agents" (
	"distillation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "project_context_distillation_agents_pk" PRIMARY KEY("distillation_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "project_context_distillation_agents" ADD CONSTRAINT "project_context_distillation_agents_distillation_id_project_context_distillations_id_fk" FOREIGN KEY ("distillation_id") REFERENCES "public"."project_context_distillations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "project_context_distillation_context_inputs" (
	"distillation_id" uuid NOT NULL,
	"context_item_id" uuid NOT NULL,
	CONSTRAINT "project_context_distillation_context_inputs_pk" PRIMARY KEY("distillation_id","context_item_id")
);
--> statement-breakpoint
ALTER TABLE "project_context_distillation_context_inputs" ADD CONSTRAINT "project_context_distillation_context_inputs_distillation_id_project_context_distillations_id_fk" FOREIGN KEY ("distillation_id") REFERENCES "public"."project_context_distillations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_context_distillation_context_inputs_item_idx" ON "project_context_distillation_context_inputs" USING btree ("context_item_id");
