-- ADR-0105 — CONSENT CONTEXT BINDING AND EXPIRY: bind a consent to the POLICY
-- that demanded it, and stop an approved-but-unspent consent from living
-- forever.
--
-- THE GAP. ADR-0104 (migration 0106) bound an approval to its PAYLOAD. It did
-- not bind it to the policy context, and approvals never expired. Two distinct
-- consequences, both real:
--
--   * STALE POLICY / STALE APPROVER. A consent queued and signed under rule
--     version A stayed spendable after a STRICTER version B activated, or after
--     the rule was edited to name a DIFFERENT required approver — provided
--     user/server/tool/project/arguments were unchanged. The check ran against
--     yesterday's policy and the use happened under today's: an authorization
--     time-of-check/time-of-use gap.
--   * NO EXPIRY. An approved, unconsumed row was spendable indefinitely. An
--     approval is a human decision about ONE pending action; a signature that
--     is still live a month later is not the decision that human made.
--
-- WHAT THE COLUMNS ARE FOR.
--
--   `approvals.context_digest`   the POLICY fingerprint — sha256 hex over the
--                                versioned canonical JSON of the MATCHED
--                                approval rules paired with each rule's ACTIVE
--                                `config_versions` id (ADR-0073), the REQUIRED
--                                APPROVER and the APPROVAL SCOPE. See
--                                packages/shared/src/approval-binding.ts. It is
--                                a SECOND digest, deliberately not folded into
--                                ADR-0104's payload digest, so "the payload
--                                changed" and "the policy changed" fail
--                                independently and stay distinguishable in the
--                                audit trail.
--   `approvals.expires_at`       when the consent stops being spendable,
--                                stamped at QUEUE time as
--                                requested_at + org_settings.approval_ttl_hours.
--   `org_settings.approval_ttl_hours`
--                                the dial, in HOURS. DEFAULT 72.
--
-- BOTH `approvals` COLUMNS ARE NULLABLE, AND THAT IS LOAD-BEARING — the same
-- reasoning migration 0106 wrote down. Rows that exist when this migration runs
-- were queued before either fact was computed; they legitimately have neither.
--
-- THE TWO LEGACY TREATMENTS ARE DELIBERATELY DIFFERENT, AND ADR-0105 ARGUES
-- BOTH:
--   * `context_digest IS NULL` is ACCEPTED. Such a row is still PAYLOAD-bound
--     under ADR-0104 (an action-scoped call already refuses a legacy NULL
--     `arguments_digest`, so the surviving population is small, recent and
--     already fingerprinted). Rejecting it would re-queue consents for a
--     property that did not exist when they were signed, on top of the
--     re-queue 0106 already caused — two upgrade-day storms for one gap.
--   * `expires_at IS NULL` DOES NOT EXPIRE. There is no honest requested_at-
--     relative TTL to impose retroactively, and inventing one would retire
--     signatures under a rule nobody agreed to.
-- Both populations heal on their next re-queue, which is born with both facts.
--
-- `approval_ttl_hours` DEFAULTS TO 72 AND THEREFORE BACKFILLS EVERY EXISTING
-- SETTINGS ROW. That is the point, and it is NOT ADR-0098's "ship the dial
-- off" posture: an approval with no expiry is the defect, so shipping NULL
-- would leave the gap open for exactly the population that already has it.
-- Setting the dial back to NULL is a supported operator choice that knowingly
-- reopens it. Note the asymmetry with the paragraph above: the DIAL is on by
-- default for every FUTURE consent, while consents that already exist keep
-- their NULL expiry — a dial change never rewrites a stamped row.
--
-- NO DATA IS REWRITTEN AND NOTHING IS DROPPED. Three ADD COLUMNs and one CHECK.
-- No new index: the consumption predicate is a primary-key UPDATE, and the
-- ADR-0104 `approvals_payload_binding_idx` still serves the candidate load —
-- the two new columns are FILTERS applied to the handful of rows it returns,
-- not selectors.

ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "context_digest" text;
--> statement-breakpoint
ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "approval_ttl_hours" integer DEFAULT 72;
--> statement-breakpoint
ALTER TABLE "org_settings"
  DROP CONSTRAINT IF EXISTS "org_settings_approval_ttl_hours_check";
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_approval_ttl_hours_check"
  CHECK ("approval_ttl_hours" IS NULL OR ("approval_ttl_hours" >= 1 AND "approval_ttl_hours" <= 8760));
