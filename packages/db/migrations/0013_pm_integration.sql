CREATE TABLE "pm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"project" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"mapping" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pm_connections_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "pm_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"node_id" text,
	"external_id" text NOT NULL,
	"external_url" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pm_links" ADD CONSTRAINT "pm_links_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "pm_connections"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "pm_links_conn_obj_node_uq" ON "pm_links" ("connection_id","object_type","object_id","node_id") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "pm_links_object_idx" ON "pm_links" ("object_type","object_id");
