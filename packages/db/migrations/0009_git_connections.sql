CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"token_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_connections_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN "context" jsonb DEFAULT '{}'::jsonb NOT NULL;
