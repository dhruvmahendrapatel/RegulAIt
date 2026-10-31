-- ADR-0224 (P13 c): privacy operations, part 2 — data-subject requests and erasure tombstones.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `data_subject_requests` holds no personal data: `subject_digest` is an HMAC of the normalised identifier, and
--    `located` holds per-store counts only. The CHECKs pin the vocabularies and that a closed request has a close time.
-- 2. `data_subject_tombstones`: where an erasure may not delete (the tamper-evident audit trail, ADR-0067), the rows it
--    covered are listed with the date their retention rule lets them be pruned. Nothing in the audit trail is edited.

CREATE TABLE IF NOT EXISTS "data_subject_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "identifier_kind" text NOT NULL,
  "subject_digest" text NOT NULL,
  "reference" text,
  "processing_record_id" uuid REFERENCES "processing_records"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "located" jsonb,
  "located_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "close_note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "data_subject_requests_kind_check" CHECK ("kind" IN ('access', 'erasure', 'objection')),
  CONSTRAINT "data_subject_requests_identifier_kind_check" CHECK ("identifier_kind" IN ('email', 'phone')),
  CONSTRAINT "data_subject_requests_status_check" CHECK ("status" IN ('received', 'in_progress', 'completed', 'rejected')),
  CONSTRAINT "data_subject_requests_digest_check" CHECK ("subject_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "data_subject_requests_due_check" CHECK ("due_at" > "received_at"),
  CONSTRAINT "data_subject_requests_closed_check" CHECK (("status" IN ('completed', 'rejected')) = ("closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_subject_requests_open_due_idx" ON "data_subject_requests" ("due_at") WHERE "status" IN ('received', 'in_progress');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_subject_tombstones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "data_subject_requests"("id") ON DELETE CASCADE,
  "store" text NOT NULL,
  "row_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "row_count" integer NOT NULL,
  "retained_until" timestamp with time zone,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "data_subject_tombstones_store_check" CHECK ("store" IN ('accounts', 'conversations', 'project_context', 'audit_trail')),
  CONSTRAINT "data_subject_tombstones_count_check" CHECK ("row_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_subject_tombstones_request_store_uq" ON "data_subject_tombstones" ("request_id", "store");
