ALTER TABLE "pm_connections" ADD COLUMN "webhook_secret_hash" text;
--> statement-breakpoint
ALTER TABLE "pm_links" ADD COLUMN "inbound_state" text;
--> statement-breakpoint
ALTER TABLE "pm_links" ADD COLUMN "inbound_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pm_links" ADD COLUMN "orphaned_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "pm_sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"link_id" uuid,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pm_sync_events" ADD CONSTRAINT "pm_sync_events_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "pm_connections"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "pm_sync_events_conn_idx" ON "pm_sync_events" ("connection_id","received_at");
