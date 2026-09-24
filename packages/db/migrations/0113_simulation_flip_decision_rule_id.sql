-- ADR-0120 correction — a flip row can now name a rule that HAS no uuid.
--
-- `policy_simulation_flips.policy_id` is a uuid, and it was right for what it
-- was built for: ABAC simulation writes `decision.policyId`, which is always a
-- real `abac_policies` row. ADR-0120 widened the CANDIDATE to approval rules
-- and rate limits and reused that column for the kernel's `Decision.ruleId` —
-- which is NOT a uuid in general. It is a uuid when a stored rule row matched,
-- and a SYMBOLIC identifier ('default-deny' and its siblings) when the decision
-- came from the kernel's own reasoning rather than from a row.
--
-- The result was a 22P02 (invalid_text_representation) on the flip insert, so
-- the whole simulation returned 500 — and only for transcripts containing a
-- decision that fell through to a symbolic rule. A preview of a restrictive
-- rule over real traffic is EXACTLY the case that produces those, so this
-- failed on the shape of request the feature exists to serve while passing on
-- a fixture whose every decision matched a stored row.
--
-- The fix keeps both facts rather than dropping one. `policy_id` goes back to
-- meaning "an abac_policies row" only, and `decision_rule_id` carries the
-- kernel's rule id verbatim, whatever shape it takes. Losing the symbolic id
-- would have thrown away the reason the row flipped, which is the entire point
-- of a blast-radius preview.
--
-- No backfill: rows written before this either carry a genuine policy uuid
-- (ABAC simulations, unaffected) or do not exist, because the insert that would
-- have written a symbolic id is the one that was failing.

ALTER TABLE "policy_simulation_flips"
  ADD COLUMN IF NOT EXISTS "decision_rule_id" text;

COMMENT ON COLUMN "policy_simulation_flips"."decision_rule_id" IS
  'The kernel Decision.ruleId that produced the simulated effect, verbatim. A uuid when a stored rule row matched, a symbolic id (e.g. default-deny) when the kernel decided without one. policy_id remains an abac_policies reference and is null for rule/rate-limit candidates.';
