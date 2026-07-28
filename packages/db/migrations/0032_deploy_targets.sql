CREATE TABLE IF NOT EXISTS "deploy_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text,
	"base_url" text,
	"credential_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_targets_name_unique" UNIQUE("name")
);
