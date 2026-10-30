-- ADR-0221 (PENDING P4): what a supplier submits through the portal. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent.
--
-- One row = one answer: either to a control of the framework's active pack (`kind = 'control'`) or to one question
-- of the grant's custom questionnaire version (`kind = 'question'`). It is a CLAIM the supplier made, held for review:
-- it reaches the vendor's attestations (ADR-0084) only when a platform reviewer accepts it, and the attestation then
-- names both the supplier who submitted it and the reviewer who recorded it.
--
-- An optional evidence file is stored as a data-key envelope (`file_ciphertext`, CIPHERTEXT_COLUMNS) with its
-- declared name, the type the gateway detected from its bytes, its size and sha256, and the scan hook's verdict.
-- The file columns are all set or all empty. `decision_reason` is registered with the ADR-0102 prose scrub.

CREATE TABLE IF NOT EXISTS "supplier_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "access_id" uuid NOT NULL REFERENCES "supplier_access"("id") ON DELETE CASCADE,
  "vendor_id" uuid NOT NULL REFERENCES "ai_vendors"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "control_ref" text,
  "questionnaire_id" uuid REFERENCES "supplier_questionnaires"("id") ON DELETE RESTRICT,
  "question_id" text,
  "statement" text NOT NULL,
  "file_name" text,
  "file_content_type" text,
  "file_size" integer,
  "file_sha256" text,
  "file_ciphertext" text,
  "scan_status" text,
  "status" text DEFAULT 'submitted' NOT NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_submissions_kind_check" CHECK (
    ("kind" = 'control' AND "control_ref" IS NOT NULL AND "question_id" IS NULL AND "questionnaire_id" IS NULL)
    OR ("kind" = 'question' AND "question_id" IS NOT NULL AND "questionnaire_id" IS NOT NULL)
  ),
  CONSTRAINT "supplier_submissions_control_ref_check" CHECK ("control_ref" IS NULL OR char_length("control_ref") BETWEEN 1 AND 200),
  CONSTRAINT "supplier_submissions_question_id_check" CHECK ("question_id" IS NULL OR "question_id" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT "supplier_submissions_statement_check" CHECK (char_length("statement") BETWEEN 1 AND 4000),
  CONSTRAINT "supplier_submissions_file_check" CHECK (
    ("file_name" IS NULL AND "file_content_type" IS NULL AND "file_size" IS NULL AND "file_sha256" IS NULL
      AND "file_ciphertext" IS NULL AND "scan_status" IS NULL)
    OR ("file_name" IS NOT NULL AND "file_content_type" IN ('application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv')
      AND "file_size" BETWEEN 1 AND 2097152 AND "file_sha256" ~ '^[0-9a-f]{64}$' AND "file_ciphertext" IS NOT NULL
      AND "scan_status" IN ('not_scanned', 'clean'))
  ),
  CONSTRAINT "supplier_submissions_file_name_check" CHECK ("file_name" IS NULL OR char_length("file_name") BETWEEN 1 AND 200),
  CONSTRAINT "supplier_submissions_status_check" CHECK ("status" IN ('submitted', 'accepted', 'rejected')),
  CONSTRAINT "supplier_submissions_decision_check" CHECK (
    ("status" = 'submitted' AND "decided_at" IS NULL AND "decision_reason" IS NULL)
    OR ("status" IN ('accepted', 'rejected') AND "decided_at" IS NOT NULL)
  ),
  CONSTRAINT "supplier_submissions_reason_check" CHECK (
    "decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 1 AND 2000
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_submissions_vendor_idx" ON "supplier_submissions" ("vendor_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_submissions_access_idx" ON "supplier_submissions" ("access_id");
