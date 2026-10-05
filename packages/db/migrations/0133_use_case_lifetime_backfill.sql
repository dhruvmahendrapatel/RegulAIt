-- ADR-0170 §6 — an approval without an end date is not an approval without end.
--
-- Migration 0129 added `approved_at` / `approved_until` without a backfill, so a
-- use case approved before ADR-0168 shipped lifetimes still reads NULL/NULL. The
-- deploy gate and the recertification sweep both skip a NULL `approved_until`,
-- which made those approvals valid forever. This backfills them with the same
-- rule the decide path applies at approval time (use-cases.ts):
--
--   approved_at    = coalesce(approved_at, updated_at, created_at)
--   approved_until = approved_at + the review policy's validityMonths for the
--                    tier when one is set, else 12 months for a minimal or
--                    limited tier and 6 months for every other tier (high,
--                    prohibited, unscreened — none of them safer than high).
--
-- Both columns are written in ONE statement (the 0129 CHECK requires them to
-- be NULL together). Only `approved` rows with a NULL `approved_until` are
-- touched; a row whose backfilled lifetime is already over is expired at once
-- (the gates refuse it and the next sweep moves it back into review), which is
-- the honest reading of an approval that old. Idempotent: a second run finds no
-- NULL rows.
WITH "policy" AS (
  SELECT "tiers" FROM "governance_review_policy" WHERE "id" = 'default'
),
"candidates" AS (
  SELECT
    uc."id",
    coalesce(uc."approved_at", uc."updated_at", uc."created_at") AS "from_at",
    coalesce(
      (SELECT ("tiers" -> coalesce(uc."eu_ai_act_tier", 'unscreened') ->> 'validityMonths')::int FROM "policy"),
      CASE WHEN uc."eu_ai_act_tier" IN ('minimal', 'limited') THEN 12 ELSE 6 END
    ) AS "months"
  FROM "ai_use_cases" uc
  WHERE uc."status" = 'approved' AND uc."approved_until" IS NULL
)
UPDATE "ai_use_cases" AS t
SET
  "approved_at" = c."from_at",
  "approved_until" = c."from_at" + make_interval(months => c."months")
FROM "candidates" c
WHERE t."id" = c."id";
