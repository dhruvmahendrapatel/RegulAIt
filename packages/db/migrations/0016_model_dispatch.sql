ALTER TABLE "agents" ADD COLUMN "model" text;
--> statement-breakpoint
CREATE TABLE "model_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_credentials_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_agent_id" uuid,
	"baseline_agent_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" double precision,
	"measured_cost_saved_usd" double precision,
	"stop_reason" text NOT NULL,
	"refusal" boolean DEFAULT false NOT NULL,
	"provider_message_id" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX "usage_events_user_idx" ON "usage_events" USING btree ("user_id","at");
