CREATE TABLE "semantic_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"prompt_hash" text NOT NULL,
	"normalized_input" text NOT NULL,
	"output_text" text NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_cache_user_agent_hash_uq" ON "semantic_cache" USING btree ("user_id","agent_id","prompt_hash");
