-- Pillar 1 connectors + pillar 5 §10.3: give a connector a real execution
-- adapter, a credential, a price, and one attributed usage_events row per
-- allowed call. A connector with a null provider_kind keeps today's
-- governance-only behaviour (decision + audit, no execution, no cost).
ALTER TABLE "connectors" ADD COLUMN "provider_kind" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "price_per_call_usd" double precision;--> statement-breakpoint

-- Platform-scoped connector credential (mirrors model_credentials): AES-256-GCM
-- ciphertext under REGULAIT_DATA_KEY, never returned by any endpoint. Keyless
-- kinds (mock / unauthenticated generic) never write a row here.
CREATE TABLE "connector_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"token_ciphertext" text NOT NULL,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_credentials_connector_unique" UNIQUE("connector_id")
);--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- UNIFIED SPEND LEDGER: usage_events now carries BOTH agent (model-dispatch)
-- rows and connector rows, so the per-project rollup picks connector spend up
-- automatically. The token/model columns become nullable — a connector call
-- has no tokens or model — and object_type/connector_id/operation are added.
-- Existing rows are stamped 'agent' by the column default.
ALTER TABLE "usage_events" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "input_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "output_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "stop_reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "object_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "operation" text;
