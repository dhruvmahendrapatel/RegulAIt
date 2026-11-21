-- ADR-0352 (lane E33 slice 2): the meaning-based cache tier behind the exact semantic cache.
-- Off by default (ADR-0180); on needs an enabled text_embedding embedder, checked by the settings PUT.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "semantic_cache_similarity_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "semantic_cache_similarity_min" double precision DEFAULT 0.95 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "semantic_cache_embedder_id" uuid;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_semantic_cache_embedder_id_external_scorers_id_fk"
  FOREIGN KEY ("semantic_cache_embedder_id") REFERENCES "public"."external_scorers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_semantic_cache_similarity_min_check"
  CHECK ("org_settings"."semantic_cache_similarity_min" BETWEEN 0.8 AND 0.999);
--> statement-breakpoint
-- One vector per cache row the tier may match. The owner (user, agent) is the parent row's and is joined for;
-- partition_key commits to everything in the exact key except the input text, so only rows produced for the same
-- user, agent, project, options and serving configuration are ever compared.
CREATE TABLE IF NOT EXISTS "semantic_cache_embeddings" (
  "cache_id" uuid PRIMARY KEY NOT NULL,
  "partition_key" text NOT NULL,
  "embedder_id" uuid NOT NULL,
  "embedder_model" text NOT NULL,
  "embedding" double precision[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "semantic_cache_embeddings_dims_check" CHECK (cardinality("semantic_cache_embeddings"."embedding") BETWEEN 16 AND 4096)
);
--> statement-breakpoint
ALTER TABLE "semantic_cache_embeddings" ADD CONSTRAINT "semantic_cache_embeddings_cache_id_semantic_cache_id_fk"
  FOREIGN KEY ("cache_id") REFERENCES "public"."semantic_cache"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "semantic_cache_embeddings" ADD CONSTRAINT "semantic_cache_embeddings_embedder_id_external_scorers_id_fk"
  FOREIGN KEY ("embedder_id") REFERENCES "public"."external_scorers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_cache_embeddings_partition_idx"
  ON "semantic_cache_embeddings" USING btree ("partition_key", "embedder_id", "embedder_model", "created_at");
