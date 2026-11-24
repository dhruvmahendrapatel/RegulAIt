-- ADR-0328 slice 2 (lane E12): repetitive-ask detection. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. No function and no trigger.
--   repetitive_ask_settings        one row, absent until an admin first saves it. Absent = OFF (ADR-0180): no scan runs.
--                                  Thresholds default strict and are bounded by the kernel's REPETITIVE_ASK_FLOORS, so a
--                                  row written around the API cannot relax past them.
--   repetitive_ask_clusters        one row per (agent, cluster fingerprint): the latest scan's measurement (a measured
--                                  read model of trace_spans, its source of truth; ADR-0200 exception) and the
--                                  suggested cheaper agent with a projected monthly saving. No prompt text is stored.
--                                  Detection is read-only: nothing here changes routing.
--   repetitive_ask_cluster_spans   a bounded sample of each cluster's member spans (a join table), the sample the
--                                  ADR-0044 eval gate will be built from (slice 3). A span pruned by retention leaves.
-- RLS: deployment-wide configuration behind admin-only routes (ADR-0234 appendix), like the rule-step tables.

CREATE TABLE IF NOT EXISTS "repetitive_ask_settings" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "max_hamming" integer DEFAULT 3 NOT NULL,
  "min_similarity" double precision DEFAULT 0.9 NOT NULL,
  "min_cluster_size" integer DEFAULT 20 NOT NULL,
  "last_scan_at" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repetitive_ask_settings_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "repetitive_ask_settings_max_hamming_check" CHECK ("max_hamming" BETWEEN 0 AND 5),
  CONSTRAINT "repetitive_ask_settings_min_similarity_check" CHECK ("min_similarity" >= 0.8 AND "min_similarity" <= 1),
  CONSTRAINT "repetitive_ask_settings_min_cluster_size_check" CHECK ("min_cluster_size" BETWEEN 10 AND 100000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repetitive_ask_clusters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "asks" integer NOT NULL,
  "cohesion" double precision NOT NULL,
  "window_cost_usd" double precision,
  "candidate_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "projected_monthly_savings_usd" double precision,
  "status" text DEFAULT 'suggested' NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dismissed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "dismissed_at" timestamp with time zone,
  CONSTRAINT "repetitive_ask_clusters_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{16}$'),
  CONSTRAINT "repetitive_ask_clusters_asks_check" CHECK ("asks" >= 2),
  CONSTRAINT "repetitive_ask_clusters_cohesion_check" CHECK ("cohesion" BETWEEN 0 AND 1),
  CONSTRAINT "repetitive_ask_clusters_status_check" CHECK ("status" IN ('suggested', 'dismissed')),
  CONSTRAINT "repetitive_ask_clusters_dismissed_check" CHECK (("status" = 'dismissed') = ("dismissed_at" IS NOT NULL)),
  CONSTRAINT "repetitive_ask_clusters_candidate_check" CHECK ("candidate_agent_id" IS NULL OR "candidate_agent_id" <> "agent_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repetitive_ask_clusters_agent_fingerprint_uq" ON "repetitive_ask_clusters" ("agent_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repetitive_ask_clusters_status_savings_idx" ON "repetitive_ask_clusters" ("status", "projected_monthly_savings_usd");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repetitive_ask_clusters_candidate_idx" ON "repetitive_ask_clusters" ("candidate_agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repetitive_ask_cluster_spans" (
  "cluster_id" uuid NOT NULL REFERENCES "repetitive_ask_clusters"("id") ON DELETE CASCADE,
  "span_id" uuid NOT NULL REFERENCES "trace_spans"("id") ON DELETE CASCADE,
  CONSTRAINT "repetitive_ask_cluster_spans_pk" PRIMARY KEY ("cluster_id", "span_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repetitive_ask_cluster_spans_span_idx" ON "repetitive_ask_cluster_spans" ("span_id");
