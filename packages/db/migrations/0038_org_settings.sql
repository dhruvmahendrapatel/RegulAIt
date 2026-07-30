CREATE TABLE "org_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"routing_enabled" boolean DEFAULT true NOT NULL,
	"compaction_enabled" boolean DEFAULT true NOT NULL,
	"prompt_caching_enabled" boolean DEFAULT true NOT NULL,
	"edit_vs_rewrite_enabled" boolean DEFAULT true NOT NULL,
	"file_preprocessing_enabled" boolean DEFAULT true NOT NULL,
	"lazy_tool_loading_enabled" boolean DEFAULT true NOT NULL,
	"default_routing_mode" text DEFAULT 'automatic' NOT NULL,
	"compaction_threshold_tokens" integer DEFAULT 1600 NOT NULL,
	"compaction_recent_window" integer DEFAULT 4 NOT NULL,
	"min_cacheable_tokens" integer DEFAULT 1024 NOT NULL,
	"cache_read_discount" double precision DEFAULT 0.9 NOT NULL,
	"max_tools_in_manifest" integer DEFAULT 20 NOT NULL,
	"min_editable_baseline_tokens" integer DEFAULT 200 NOT NULL,
	"batch_overhead_tokens" integer DEFAULT 200 NOT NULL,
	"min_preprocess_tokens" integer DEFAULT 200 NOT NULL,
	"semantic_cache_policy" text DEFAULT 'opt_in' NOT NULL,
	"semantic_cache_ttl_seconds" integer DEFAULT 3600 NOT NULL,
	"compaction_failure_mode" text DEFAULT 'fail_open' NOT NULL,
	"summarizer_selection" text DEFAULT 'cheapest' NOT NULL,
	"summarizer_agent_id" uuid,
	"default_pii_mode" text DEFAULT 'none' NOT NULL,
	"env_key_fallback_enabled" boolean DEFAULT true NOT NULL,
	"env_fallback_providers" jsonb DEFAULT '["anthropic","openai","google","xai"]'::jsonb NOT NULL,
	"budget_enforcement" text DEFAULT 'block' NOT NULL,
	"budget_hard_block_pct" integer DEFAULT 100 NOT NULL,
	"approval_quorum" text DEFAULT 'all' NOT NULL,
	"auto_prune_enabled" boolean DEFAULT false NOT NULL,
	"prune_interval_hours" integer DEFAULT 24 NOT NULL,
	"default_audit_retention_days" integer,
	"default_worker_max_turns" integer DEFAULT 6 NOT NULL,
	"max_worker_turns" integer DEFAULT 20 NOT NULL,
	"max_attachments_per_dispatch" integer DEFAULT 8 NOT NULL,
	"max_attachment_bytes" integer DEFAULT 6291456 NOT NULL,
	"image_token_estimate_tokens" integer DEFAULT 1200 NOT NULL,
	"shared_context_max_chars" integer DEFAULT 100000 NOT NULL,
	"node_output_max_chars" integer DEFAULT 20000 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_settings_singleton" CHECK ("org_settings"."id" = 'singleton')
);
--> statement-breakpoint
INSERT INTO "org_settings" ("id") VALUES ('singleton') ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "interception_settings" ADD COLUMN "streaming_on_block_mode" text DEFAULT 'suppress' NOT NULL;
--> statement-breakpoint
ALTER TABLE "interception_settings" ADD COLUMN "strict_field_rejection" boolean DEFAULT false NOT NULL;
