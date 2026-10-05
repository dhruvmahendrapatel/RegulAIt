-- ADR-0173 batch 2c (Q) — annotation queues.
--
-- annotation_queues           a named queue: N-person requirement, optional SLA,
--                             the current rubric version
-- annotation_rubric_versions  every rubric a queue has had; a rubric edit after
--                             reviews exist under the current version writes a
--                             new version
-- annotation_queue_reviewers  the named reviewers (the only non-admins who may
--                             read the queue's items, previews only)
-- annotation_items            one subject (trace / span / eval result) per
--                             queue, at most once. The subject and its trace
--                             are FK-free on purpose: when the §8.3 prune or an
--                             erasure deletes the trace, the item and its
--                             reviews stay and read "no longer retained".
-- annotation_submissions      one review per (item, reviewer); the comment is
--                             at most 2000 characters
CREATE TABLE IF NOT EXISTS "annotation_queues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "rubric_version" integer DEFAULT 1 NOT NULL,
  "required_reviews" integer DEFAULT 1 NOT NULL,
  "sla_hours" integer,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "annotation_queues_required_ck" CHECK ("required_reviews" BETWEEN 1 AND 5),
  CONSTRAINT "annotation_queues_sla_ck" CHECK ("sla_hours" IS NULL OR "sla_hours" BETWEEN 1 AND 720)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annotation_queues_name_uq" ON "annotation_queues" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annotation_rubric_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "queue_id" uuid NOT NULL REFERENCES "annotation_queues"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "rubric" jsonb NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annotation_rubric_versions_queue_version_uq" ON "annotation_rubric_versions" ("queue_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annotation_queue_reviewers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "queue_id" uuid NOT NULL REFERENCES "annotation_queues"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annotation_queue_reviewers_uq" ON "annotation_queue_reviewers" ("queue_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annotation_queue_reviewers_user_idx" ON "annotation_queue_reviewers" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annotation_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "queue_id" uuid NOT NULL REFERENCES "annotation_queues"("id") ON DELETE CASCADE,
  "subject_kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "trace_id" uuid,
  "span_id" uuid,
  "subject_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "required_reviews" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "due_at" timestamp with time zone,
  "sla_breached_at" timestamp with time zone,
  "disagreement" boolean,
  "disagreement_detail" jsonb,
  "completed_at" timestamp with time zone,
  "enqueued_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "rule_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "annotation_items_kind_ck" CHECK ("subject_kind" IN ('trace', 'span', 'eval_result')),
  CONSTRAINT "annotation_items_status_ck" CHECK ("status" IN ('open', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annotation_items_queue_subject_uq" ON "annotation_items" ("queue_id", "subject_kind", "subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annotation_items_queue_status_idx" ON "annotation_items" ("queue_id", "status", "created_at");
--> statement-breakpoint
-- the SLA sweep reads open, not-yet-breached items by deadline
CREATE INDEX IF NOT EXISTS "annotation_items_due_idx" ON "annotation_items" ("due_at") WHERE "status" = 'open' AND "sla_breached_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annotation_items_subject_idx" ON "annotation_items" ("subject_kind", "subject_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annotation_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL REFERENCES "annotation_items"("id") ON DELETE CASCADE,
  "queue_id" uuid NOT NULL REFERENCES "annotation_queues"("id") ON DELETE CASCADE,
  "reviewer_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "rubric_version" integer NOT NULL,
  "values" jsonb NOT NULL,
  "comment" text,
  "payload_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "annotation_submissions_comment_ck" CHECK ("comment" IS NULL OR char_length("comment") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annotation_submissions_item_reviewer_uq" ON "annotation_submissions" ("item_id", "reviewer_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annotation_submissions_queue_created_idx" ON "annotation_submissions" ("queue_id", "created_at", "id");
