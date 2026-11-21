-- ADR-0327 slice 4a (lane E12): switching a rule-like AI step to its rule. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. One guard function and its triggers.
--   rule_step_suggestions.status  gains 'switched': the rule answers the step for inputs it covers (served by slice 4b;
--                                 until then nothing reads it on the request path and the AI still answers).
--   rule_step_switches            one row per switch request: made from shadow by an admin (step-up), decided by a
--                                 named reviewer through the approvals queue (object_type rule_step_switch), reverted by
--                                 an admin in one action. `rule_sha256` is the canonical-JSON digest of the rule the
--                                 request was made for; the approval carries the same digest, and the decide path
--                                 refuses to switch on a mismatch. A BEFORE UPDATE trigger freezes the suggestion, the
--                                 digest, the request time and the requester (which may only become NULL, the users FK's
--                                 ON DELETE SET NULL). At most one open (pending or switched) request per suggestion.
-- RLS: deployment-wide configuration behind admin-only routes (ADR-0234 appendix), like the other rule-step tables.

ALTER TABLE "rule_step_suggestions" DROP CONSTRAINT IF EXISTS "rule_step_suggestions_status_check";
ALTER TABLE "rule_step_suggestions" ADD CONSTRAINT "rule_step_suggestions_status_check"
  CHECK ("status" IN ('suggested', 'shadow', 'switched', 'dismissed'));

CREATE TABLE IF NOT EXISTS "rule_step_switches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "suggestion_id" uuid NOT NULL REFERENCES "rule_step_suggestions"("id") ON DELETE CASCADE,
  "rule_sha256" text NOT NULL,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reason" text,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "reverted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reverted_at" timestamp with time zone,
  "revert_reason" text,
  CONSTRAINT "rule_step_switches_rule_sha256_check" CHECK ("rule_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "rule_step_switches_status_check"
    CHECK ("status" IN ('pending_review', 'switched', 'rejected', 'stale', 'reverted')),
  CONSTRAINT "rule_step_switches_decided_check" CHECK (("status" = 'pending_review') = ("decided_at" IS NULL)),
  CONSTRAINT "rule_step_switches_reverted_check" CHECK (("status" = 'reverted') = ("reverted_at" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "rule_step_switches_one_open_uq" ON "rule_step_switches" ("suggestion_id")
  WHERE "status" IN ('pending_review', 'switched');
CREATE INDEX IF NOT EXISTS "rule_step_switches_suggestion_requested_idx" ON "rule_step_switches" ("suggestion_id", "requested_at");
CREATE INDEX IF NOT EXISTS "rule_step_switches_approval_idx" ON "rule_step_switches" ("approval_id");

-- what was requested and approved cannot change after insert
CREATE OR REPLACE FUNCTION public."rule_step_switches_freeze"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."suggestion_id" IS DISTINCT FROM OLD."suggestion_id"
     OR NEW."rule_sha256" IS DISTINCT FROM OLD."rule_sha256"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR (NEW."requested_by" IS DISTINCT FROM OLD."requested_by" AND NEW."requested_by" IS NOT NULL) THEN
    RAISE EXCEPTION 'rule_step_switches: a switch request is frozen; make a new request instead (ADR-0327)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "rule_step_switches_freeze" ON public."rule_step_switches";
CREATE TRIGGER "rule_step_switches_freeze" BEFORE UPDATE ON public."rule_step_switches"
  FOR EACH ROW EXECUTE FUNCTION public."rule_step_switches_freeze"();

-- a TRUNCATE skips every row trigger: refused that way too (migration 0185's rule)
DROP TRIGGER IF EXISTS "rule_step_switches_no_truncate" ON public."rule_step_switches";
CREATE TRIGGER "rule_step_switches_no_truncate" BEFORE TRUNCATE ON public."rule_step_switches"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
