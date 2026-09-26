-- ADR-0073/0074 residual (batch B1) — THE DELETE PATH FOR VERSIONED RULES.
--
-- ADR-0074 §5 named the correct end state for a rule that ceases to exist: a
-- TOMBSTONE — its version pointers demoted OUT of the active/canary space, its
-- rows kept (they are the record of what governed the calls made while the rule
-- existed), and the demotion itself appended to the activation ledger. This
-- migration adds the two vocabulary values that tombstone needs:
--
--   status 'retired'          a version demoted because its ARTIFACT was
--                             deleted. Deliberately not 'superseded' (which
--                             means "replaced by a newer active") and not
--                             'rolled_back' (which means "an older version was
--                             re-activated over it") — reusing either would
--                             misstate the version's history, the exact move
--                             ADR-0074 refused when it declined to mark a
--                             displaced canary 'rolled_back'.
--   action 'artifact_deleted' the append-only ledger entry recording WHY the
--                             pointer moved.
--
-- The partial unique indexes on status='active'/'canary' are untouched: a
-- 'retired' row simply falls outside both, which is the whole point. The
-- canary_pct CHECK already forces canary_pct NULL for any non-'canary' status,
-- so the demotion nulls it.
--
-- SCOPE, stated plainly: only the EXPLICIT DELETE route demotes. A rule that
-- vanishes through an FK cascade (deleting a user/server/role/team/approver
-- cascades the rule row away with no application code involved) still leaves
-- its versions behind with the pointers intact — that path needs the AFTER
-- DELETE trigger ADR-0074 §5 scoped as its own slice, and the read surfaces go
-- on disclosing those orphans with `artifactDeleted: true` exactly as before.

ALTER TABLE "config_versions" DROP CONSTRAINT "config_versions_status_check";
--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_status_check" CHECK ("status" IN (
  'draft','canary','active','rolled_back','superseded','retired'
));
--> statement-breakpoint
ALTER TABLE "config_activation_events" DROP CONSTRAINT "config_activation_events_action_check";
--> statement-breakpoint
ALTER TABLE "config_activation_events" ADD CONSTRAINT "config_activation_events_action_check" CHECK ("action" IN (
  'created','activated','canary_started','canary_adjusted','promoted','rolled_back','abandoned','artifact_deleted'
));
