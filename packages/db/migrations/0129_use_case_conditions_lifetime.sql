-- ADR-0168 — the decision is a task with real outcomes; an approval has a lifetime.
--
-- 1. `needs_info` joins the use-case lifecycle: a reviewer SENT the intake back
--    for information. The intake instance rests at its questionnaire stage
--    until a new version is submitted, which re-requests the sign-off.
-- 2. `approved_at` / `approved_until`: an approval records when it was given
--    and how long it stands — 6 months for a high (or unscreened) tier, 12 for
--    minimal and limited. Until a sweep exists, expiry is enforced at the
--    deploy gate (`approval_expired`), not swept.
-- 3. `use_case_conditions`: "approve with conditions". Each condition has an
--    owner, a due date and a reviewer tag — `blocking` = before go-live (the
--    deploy gate refuses while it is open), not blocking = after go-live
--    (tracked and shown overdue, never blocking). Written in the SAME
--    transaction as the decision that imposed it.
ALTER TABLE "ai_use_cases" DROP CONSTRAINT IF EXISTS "ai_use_cases_status_check";
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_status_check"
  CHECK ("status" IN ('proposed', 'under_review', 'needs_info', 'approved', 'rejected', 'retired'));
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "approved_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_approval_lifetime_check"
  CHECK (("approved_at" IS NULL) = ("approved_until" IS NULL));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "use_case_conditions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "use_case_id" uuid NOT NULL REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  -- the decision that imposed it (an intake sign-off on the one approvals queue)
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE CASCADE,
  "text" text NOT NULL,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "due_at" timestamp with time zone NOT NULL,
  "blocking" boolean NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "met_at" timestamp with time zone,
  "met_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "use_case_conditions_status_check" CHECK ("status" IN ('open', 'met', 'waived')),
  CONSTRAINT "use_case_conditions_text_check" CHECK (length(btrim("text")) BETWEEN 1 AND 500),
  CONSTRAINT "use_case_conditions_met_check" CHECK (("status" = 'open') = ("met_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "use_case_conditions_use_case_idx" ON "use_case_conditions" ("use_case_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "use_case_conditions_approval_idx" ON "use_case_conditions" ("approval_id");
