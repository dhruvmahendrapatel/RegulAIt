-- ADR-0171 (AER-050, AER-052, AER-053) — intake drafts, idempotent creation,
-- per-framework rationale and "Not sure" answers.
--
-- 1. `use_case_drafts`: the intake wizard's work-in-progress, server-side and
--    per user — never browser storage, because questionnaire text can be
--    sensitive. One draft per (user, scope): scope 'new' is the registration
--    wizard, a use-case id is that use case's resubmission. `state` is the
--    wizard's opaque JSON (≤ 256 KiB, checked at the route). Drafts older than
--    30 days are pruned by the routes.
-- 2. `use_case_idempotency_keys`: an `Idempotency-Key` on POST /v1/use-cases is
--    claimed here INSIDE the create transaction. The unique (user_id, key)
--    index is what stops two concurrent duplicates both creating: the second
--    insert waits on the first transaction and then conflicts. `response` is
--    the original 201 body, replayed for 24 hours. Keys are per caller.
-- 3. `ai_use_cases.framework_rationales`: the owner's "why it applies" per
--    framework (keyed by compliance tag) — previously an edit the wizard
--    offered and then discarded. Shown to reviewers.
-- 4. `ai_use_cases.screening_unsure`: the yes/no screening answers the owner
--    marked "Not sure". Each is stored and screened as `true` (the
--    conservative reading); reviewers see the list.
--
-- Additive and idempotent: no existing row changes meaning (both new columns
-- default to empty).
CREATE TABLE IF NOT EXISTS "use_case_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "state" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "use_case_drafts_user_scope_uq" ON "use_case_drafts" ("user_id", "scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "use_case_drafts_updated_idx" ON "use_case_drafts" ("updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "use_case_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "use_case_id" uuid REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "response" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "use_case_idempotency_keys_key_check" CHECK (length("key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "use_case_idempotency_keys_user_key_uq" ON "use_case_idempotency_keys" ("user_id", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "use_case_idempotency_keys_created_idx" ON "use_case_idempotency_keys" ("created_at");
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "framework_rationales" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "screening_unsure" jsonb DEFAULT '[]'::jsonb NOT NULL;
