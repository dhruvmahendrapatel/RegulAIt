ALTER TABLE "agents" ADD COLUMN "cost_per_mtok_in" double precision;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "cost_per_mtok_out" double precision;
--> statement-breakpoint
ALTER TABLE "user_agent_policies" ADD COLUMN "routing_mode" text DEFAULT 'automatic' NOT NULL;
--> statement-breakpoint
CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"object_type" text DEFAULT 'agent' NOT NULL,
	"technique" text NOT NULL,
	"object_id" uuid,
	"requested_agent_id" uuid,
	"served_agent_id" uuid,
	"baseline_agent_id" uuid,
	"estimated_tokens_in" integer DEFAULT 0 NOT NULL,
	"estimated_tokens_out" integer DEFAULT 0 NOT NULL,
	"estimated_tokens_saved" integer DEFAULT 0 NOT NULL,
	"estimated_cost_saved_usd" double precision,
	"estimation_basis" text NOT NULL,
	"rule_id" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX "cost_events_user_at_idx" ON "cost_events" ("user_id","at");
--> statement-breakpoint
CREATE INDEX "cost_events_technique_idx" ON "cost_events" ("technique");
