-- ADR-0168 amendment (2026-10-03, afternoon) — the review policy, multi-role
-- review rounds and recertification.
--
-- 1. `governance_review_policy`: ONE row (id 'default'). Admin-edited reviewer
--    roles (id, name, members), per EU AI Act tier the roles that must sign —
--    each role is one required review — an optional approval lifetime per tier,
--    and the people who may accept risk. No row (or a tier with no roles) keeps
--    the single named approver the intake template routes to.
-- 2. `approvals.review_role_id` / `review_role_name` / `review_round`: an intake
--    sign-off routed by the policy is one approval row per required role. Any
--    member of the role may decide it (never the proposer); the name is a
--    snapshot so a renamed or removed role still reads true on old rounds; the
--    round numbers the use case's review rounds so "the current reviews" is a
--    query. All NULL on every other approval (and on the single-approver path).
-- 3. `ai_use_cases.recertification`: true while an approval that EXPIRED is
--    back in review (set by the recertification sweep, cleared by the next
--    decision).
-- 4. `ai_use_cases.intake_answers`: every answer the registration Classify step
--    collected (the EU AI Act screening answers plus sectors, data categories,
--    deployment, EU nexus, external vendor, generative, autonomous actions,
--    tools), stored so a sent-back use case can be resubmitted prefilled. NULL
--    for use cases registered without them. The tier is still computed only
--    from the submitted questionnaire's answers block.
CREATE TABLE IF NOT EXISTS "governance_review_policy" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "risk_acceptor_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "governance_review_policy_singleton_check" CHECK ("id" = 'default')
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "review_role_id" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "review_role_name" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "review_round" integer;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_review_role_check"
  CHECK (("review_role_id" IS NULL) = ("review_role_name" IS NULL) AND ("review_role_id" IS NULL) = ("review_round" IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_review_instance_idx" ON "approvals" ("instance_id", "review_round")
  WHERE "review_role_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "recertification" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "intake_answers" jsonb;
