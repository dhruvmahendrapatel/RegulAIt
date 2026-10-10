-- ADR-0190 (batch 6 item 3) slice I3 — the EXECUTOR CORE: placement offers over the executor channel.
-- Hand-authored (never drizzle-kit generate).
--
-- 1. `execution_offers`: one row per placement OFFERED to one executor over its stream (decision 4: "the gateway
--    offers a placement; only an executor whose fresh attestation meets the required class may take it"). Rows,
--    not memory, so an offer decided on one gateway replica reaches the executor's stream held by another. An
--    offer is never deleted; its status moves forward only (guard trigger), and every terminal state is one of
--    the fixed vocabulary. The placement it ends in (`execution_placements`, append-only, I1) is named once known.
-- 2. `replay_claims.namespace` gains `executor_channel` (decision 14 claims for the channel's one-use request proofs).
--
-- Database clock rule (M-075): every stamp here is `now()`; the gateway compares with `now()` too.

-- ===== 1. execution offers ====================================================
CREATE TABLE IF NOT EXISTS "execution_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "executor_id" uuid NOT NULL REFERENCES "executors"("id") ON DELETE RESTRICT,
  "workload_kind" text NOT NULL,
  "required_class" text NOT NULL,
  "required_by" text NOT NULL,
  "enforcement" text NOT NULL,
  "profile_digest" text NOT NULL REFERENCES "execution_profiles"("digest") ON DELETE RESTRICT,
  "image_digest" text NOT NULL,
  "status" text DEFAULT 'offered' NOT NULL,
  "decline_reason" text,
  "end_outcome" text,
  "placement_id" uuid REFERENCES "execution_placements"("id") ON DELETE RESTRICT,
  "offered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "reported_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  CONSTRAINT "execution_offers_workload_kind_check" CHECK ("workload_kind" IN ('mcp_stdio', 'code_exec', 'engine_worker', 'byoc_worker')),
  CONSTRAINT "execution_offers_required_class_check" CHECK ("required_class" IN ('hardened_container', 'user_space_kernel', 'microvm')),
  CONSTRAINT "execution_offers_required_by_check" CHECK (
    "required_by" IN ('workload_kind', 'data_sensitivity', 'compliance_tag', 'autonomy_class', 'configured_profile', 'unknown_agent', 'parent_grant')
  ),
  CONSTRAINT "execution_offers_enforcement_check" CHECK ("enforcement" IN ('enforce', 'warn')),
  CONSTRAINT "execution_offers_image_digest_check" CHECK ("image_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "execution_offers_status_check" CHECK (
    "status" IN ('offered', 'accepted', 'placed', 'mismatch', 'declined', 'expired', 'withdrawn', 'ended')
  ),
  CONSTRAINT "execution_offers_decline_reason_check" CHECK (
    "decline_reason" IS NULL OR "decline_reason" IN ('attestation_stale', 'class_below_required', 'capacity', 'quarantined', 'profile_unknown')
  ),
  CONSTRAINT "execution_offers_end_outcome_check" CHECK (
    "end_outcome" IS NULL OR "end_outcome" IN ('completed', 'failed', 'killed', 'limit_exceeded')
  ),
  CONSTRAINT "execution_offers_expiry_check" CHECK ("expires_at" > "offered_at"),
  -- each status's shape
  CONSTRAINT "execution_offers_shape_check" CHECK (
    ("status" = 'offered' AND "accepted_at" IS NULL AND "reported_at" IS NULL AND "ended_at" IS NULL AND "placement_id" IS NULL AND "decline_reason" IS NULL AND "end_outcome" IS NULL)
    OR ("status" = 'accepted' AND "accepted_at" IS NOT NULL AND "reported_at" IS NULL AND "ended_at" IS NULL AND "placement_id" IS NULL AND "decline_reason" IS NULL AND "end_outcome" IS NULL)
    OR ("status" IN ('placed', 'mismatch') AND "accepted_at" IS NOT NULL AND "reported_at" IS NOT NULL AND "ended_at" IS NULL AND "placement_id" IS NOT NULL AND "decline_reason" IS NULL AND "end_outcome" IS NULL)
    OR ("status" = 'ended' AND "accepted_at" IS NOT NULL AND "reported_at" IS NOT NULL AND "ended_at" IS NOT NULL AND "placement_id" IS NOT NULL AND "decline_reason" IS NULL AND "end_outcome" IS NOT NULL)
    OR ("status" = 'declined' AND "accepted_at" IS NULL AND "reported_at" IS NULL AND "ended_at" IS NOT NULL AND "decline_reason" IS NOT NULL AND "end_outcome" IS NULL)
    OR ("status" IN ('expired', 'withdrawn') AND "ended_at" IS NOT NULL AND "decline_reason" IS NULL AND "end_outcome" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_offers_executor_status_idx" ON "execution_offers" ("executor_id", "status", "offered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_offers_open_idx" ON "execution_offers" ("expires_at") WHERE "status" IN ('offered', 'accepted');
--> statement-breakpoint
-- forward-only: offered -> accepted | declined | expired | withdrawn; accepted -> placed | mismatch | expired | withdrawn;
-- placed -> ended; everything else terminal. The offer's identity (executor, kind, class, profile, image) never changes.
CREATE OR REPLACE FUNCTION "regulait_execution_offer_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_offers: an offer is never deleted'
      USING ERRCODE = 'insufficient_privilege', HINT = 'placements name offers (ADR-0190 decision 13)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'offered' THEN
      RAISE EXCEPTION 'execution_offers: an offer is created offered' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."executor_id" IS DISTINCT FROM OLD."executor_id"
     OR NEW."workload_kind" IS DISTINCT FROM OLD."workload_kind"
     OR NEW."required_class" IS DISTINCT FROM OLD."required_class"
     OR NEW."required_by" IS DISTINCT FROM OLD."required_by"
     OR NEW."enforcement" IS DISTINCT FROM OLD."enforcement"
     OR NEW."profile_digest" IS DISTINCT FROM OLD."profile_digest"
     OR NEW."image_digest" IS DISTINCT FROM OLD."image_digest"
     OR NEW."offered_at" IS DISTINCT FROM OLD."offered_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'execution_offers: an offer''s identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (
       (OLD."status" = 'offered' AND NEW."status" IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn'))
    OR (OLD."status" = 'accepted' AND NEW."status" IN ('accepted', 'placed', 'mismatch', 'expired', 'withdrawn'))
    OR (OLD."status" = 'placed' AND NEW."status" IN ('placed', 'ended'))
    OR (OLD."status" = NEW."status" AND OLD."status" IN ('mismatch', 'declined', 'expired', 'withdrawn', 'ended') AND NEW IS NOT DISTINCT FROM OLD)
  ) THEN
    RAISE EXCEPTION 'execution_offers: % -> % is not a forward step', OLD."status", NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_offers_guard" ON "execution_offers";
--> statement-breakpoint
CREATE TRIGGER "execution_offers_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "execution_offers"
  FOR EACH ROW EXECUTE FUNCTION "regulait_execution_offer_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_offers_no_truncate" ON "execution_offers";
--> statement-breakpoint
CREATE TRIGGER "execution_offers_no_truncate" BEFORE TRUNCATE ON public."execution_offers" FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint

-- ===== 2. the executor channel's replay namespace (decision 14) ===============
ALTER TABLE "replay_claims" DROP CONSTRAINT IF EXISTS "replay_claims_namespace_check";
--> statement-breakpoint
ALTER TABLE "replay_claims" ADD CONSTRAINT "replay_claims_namespace_check" CHECK (
  "namespace" IN ('client_assertion', 'as_dpop', 'rs_dpop', 'human_delegation_proof', 'delegation_authz', 'executor_channel')
);
