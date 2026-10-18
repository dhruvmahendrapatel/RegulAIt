-- ADR-0197 owner decisions Q3 and Q13. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is
-- idempotent.
--
-- Q3: a "person's own stdio call" relaxation (ADR-0190 owner decision C, migration 0201) expires. A row is in force
-- only while it is not cleared AND `expires_at` is in the future; the default and the most a set or a renewal grants
-- is 30 days from that act. A renewal (an audited `settings_relax` step-up) moves `expires_at` forward and records
-- who renewed it and when. No grandfathering (ADR-0180): an existing row expires 30 days after it was set, so a row
-- older than that stops applying when this migration runs (fail closed).
ALTER TABLE "execution_person_stdio_relaxations" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "execution_person_stdio_relaxations" ADD COLUMN IF NOT EXISTS "renewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "execution_person_stdio_relaxations" ADD COLUMN IF NOT EXISTS "renewed_by_user_id" uuid;
--> statement-breakpoint
-- the backfill is the one write 0201's guard would refuse (it only admits a clearing), so the guard is off for it
ALTER TABLE "execution_person_stdio_relaxations" DISABLE TRIGGER "execution_person_stdio_relaxations_guard";
--> statement-breakpoint
UPDATE "execution_person_stdio_relaxations" SET "expires_at" = "created_at" + interval '30 days' WHERE "expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "execution_person_stdio_relaxations" ENABLE TRIGGER "execution_person_stdio_relaxations_guard";
--> statement-breakpoint
ALTER TABLE "execution_person_stdio_relaxations" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');
--> statement-breakpoint
ALTER TABLE "execution_person_stdio_relaxations" ALTER COLUMN "expires_at" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "execution_person_stdio_relaxations" ADD CONSTRAINT "execution_person_stdio_relaxations_expiry_check"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= COALESCE("renewed_at", "created_at") + interval '30 days');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "execution_person_stdio_relaxations" ADD CONSTRAINT "execution_person_stdio_relaxations_renewed_check"
    CHECK (("renewed_at" IS NULL) = ("renewed_by_user_id" IS NULL) AND ("renewed_at" IS NULL OR "renewed_at" >= "created_at"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- 0201's guard, extended: never deleted; an UPDATE of an uncleared row either clears it (once, changing nothing else)
-- or renews it (a later `renewed_at`, a later `expires_at`, the actor; nothing else). A cleared row never changes.
CREATE OR REPLACE FUNCTION "execution_person_stdio_relaxations_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_person_stdio_relaxations rows are never deleted (ADR-0190 owner decision C)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."cleared_at" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."scope_kind" IS DISTINCT FROM OLD."scope_kind"
     OR NEW."scope_id" IS DISTINCT FROM OLD."scope_id"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'an execution_person_stdio_relaxations row only gains its clearing, once, or a renewal (ADR-0190 owner decision C; ADR-0197 Q3)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cleared_at" IS NOT NULL THEN
    -- a clearing: the expiry and the renewal stay as they were
    IF NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."renewed_at" IS DISTINCT FROM OLD."renewed_at"
       OR NEW."renewed_by_user_id" IS DISTINCT FROM OLD."renewed_by_user_id" THEN
      RAISE EXCEPTION 'clearing an execution_person_stdio_relaxations row changes nothing else (ADR-0197 Q3)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- a renewal: a new, later renewal and a later expiry (the expiry CHECK caps it at 30 days from the renewal)
  IF NEW."renewed_at" IS NULL
     OR NEW."renewed_by_user_id" IS NULL
     OR (OLD."renewed_at" IS NOT NULL AND NEW."renewed_at" <= OLD."renewed_at")
     OR NEW."expires_at" <= OLD."expires_at" THEN
    RAISE EXCEPTION 'an execution_person_stdio_relaxations renewal records who renewed it and moves the expiry later (ADR-0197 Q3)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Q13: an endpoint agent enrolment token (ADR-0195 SD4b, migration 0207) expires within 30 days of issue, unless the
-- admin who issued it gave a `settings_relax` step-up for a longer expiry: then up to 90 days. The relaxation is
-- recorded on the row (who, the step-up method and the audit row the issue wrote), so the server enforces 30 days
-- by default and 90 only with the relaxation recorded. `expiry_relaxation_audit_id` has no foreign key on purpose:
-- audit retention may prune the row, and that must not rewrite or block the token.
ALTER TABLE "endpoint_enrolment_tokens" ADD COLUMN IF NOT EXISTS "expiry_relaxed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD COLUMN IF NOT EXISTS "expiry_relaxation_step_up" text;
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD COLUMN IF NOT EXISTS "expiry_relaxation_audit_id" uuid;
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" DROP CONSTRAINT IF EXISTS "endpoint_enrolment_tokens_expiry_check";
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD CONSTRAINT "endpoint_enrolment_tokens_expiry_check" CHECK (
  "expires_at" > "created_at" AND (
    "expires_at" <= "created_at" + interval '30 days'
    OR ("expiry_relaxation_audit_id" IS NOT NULL AND "expiry_relaxation_step_up" IS NOT NULL AND "expires_at" <= "created_at" + interval '90 days')
  )
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "endpoint_enrolment_tokens" ADD CONSTRAINT "endpoint_enrolment_tokens_expiry_relaxation_check"
    CHECK (("expiry_relaxation_audit_id" IS NULL) = ("expiry_relaxation_step_up" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
