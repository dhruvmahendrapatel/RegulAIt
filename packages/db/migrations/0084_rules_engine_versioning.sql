-- ADR-0073 — WIRE THE RULES ENGINE THROUGH `config_versions`.
--
-- ADR-0048 shipped immutable versions, canary and rollback, and wired them
-- through the ONE dispatch core for `agent_system_prompt`. For the four
-- restriction/compliance artifact types it shipped the SUBSTRATE ONLY: versions
-- stored, activated and rolled back, while the kernels went on reading their own
-- tables. §2's shadow canary for rules therefore evaluated NOTHING.
--
-- ADR-0073 closes that. The rule loaders now resolve the ACTIVE version out of
-- `config_versions` and overlay it onto the loaded row, so activating and
-- rolling back a rule version genuinely changes evaluation; and the CANDIDATE
-- (canary) version is evaluated IN PARALLEL, never enforcing, purely to record
-- what it WOULD have decided.
--
-- THIS MIGRATION ADDS ONE TABLE, and only because the divergence has nowhere
-- else honest to live:
--
--   * `audit_log` is the record of decisions that were SERVED, and since
--     ADR-0060 it is a hash-chained tamper-evident ledger. A shadow evaluation
--     is by definition NOT a served decision; writing one there would put a
--     decision nobody was subject to inside the chain an auditor reads as the
--     record of what happened. Refused on those grounds.
--   * `config_activation_events` records POINTER MOVES, not per-call
--     observations.
--   * a jsonb blob on `config_versions` would be a counter, and the operator
--     question this exists to answer — "which decisions would change, and to
--     what" — needs the rows, not the count.
--
-- NOTHING ELSE CHANGES SHAPE. No column is added to `approval_rules`,
-- `rate_limits`, `data_scope_rules` or `compliance_profiles`: their rows stay
-- exactly as they are and become the READ-MODEL of the active version, kept in
-- sync on every pointer move by the same `activateVersion` that already does it
-- for `agents.system_prompt`. There is no backfill either — an artifact with no
-- version rows resolves to its table row, which is byte-identical pre-ADR-0073
-- behaviour, and the first version an admin creates mints the v1 baseline from
-- the live row at that moment (ADR-0048 §7's behaviour-preserving default,
-- applied lazily where a migration-time backfill would have flipped every
-- existing rule onto the version path at once).
--
-- GROWTH, STATED UP FRONT: while a rule canary is running this table takes one
-- row per SAMPLED governed tool call. `canary_pct` is the sampling rate, so an
-- operator chooses the cost. There is no pruning — the same disclosure
-- ADR-0048 already carries for `config_versions`.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_canary_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_type" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"candidate_version_id" uuid NOT NULL,
	"candidate_version" integer NOT NULL,
	"active_version_id" uuid,
	"active_version" integer,
	"canary_pct" integer,
	"bucket" integer,
	"user_id" uuid,
	"server_id" uuid,
	"tool_name" text,
	"project_id" uuid,
	"served_effect" text,
	"served_rule_id" text,
	"served_reason" text,
	"candidate_effect" text,
	"candidate_rule_id" text,
	"candidate_reason" text,
	"diverged" boolean DEFAULT false NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"failure_reason" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A row is either an OBSERVATION (both effects present) or a FAILURE (the
-- candidate evaluation threw and the served decision was left completely
-- alone). Never both, never neither — a half-written observation would let a
-- promotion decision rest on a comparison that never completed.
ALTER TABLE "config_canary_observations" ADD CONSTRAINT "config_canary_observations_outcome_check" CHECK (
	("failed" = true AND "failure_reason" IS NOT NULL AND "candidate_effect" IS NULL AND "diverged" = false)
	OR ("failed" = false AND "failure_reason" IS NULL AND "candidate_effect" IS NOT NULL AND "served_effect" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_canary_obs_artifact_at_idx" ON "config_canary_observations" ("artifact_type","artifact_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_canary_obs_diverged_idx" ON "config_canary_observations" ("artifact_type","artifact_id","diverged","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_canary_obs_version_idx" ON "config_canary_observations" ("candidate_version_id","diverged");
