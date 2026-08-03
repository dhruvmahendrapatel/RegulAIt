-- Migration 0071 (ADR-0059) — POLICY SIMULATION / BLAST-RADIUS PREVIEW.
--
-- WHAT THIS MIGRATION DOES NOT ADD, AND WHY THAT IS THE POINT
--
--   No queue, no job table, no counter, no column on `abac_policies`. A
--   blast-radius run is STRICTLY DRY: it re-decides recorded history under a
--   PROPOSED policy version and writes down what it found. It dispatches
--   nothing, queues no approval, consumes no rate window, meters no usage, and
--   never touches `abac_policies.active_version_id`. The dry-run module does
--   not import the dispatch core at all, so "zero side effects" is a property
--   of the dependency graph rather than a promise in a comment.
--
--   The one side effect that DOES exist is deliberate and disclosed: a single
--   `audit_log` row recording that a simulation ran, under which entitlement
--   scope, over which window. A preview reads other people's traffic; who
--   previewed whose history has to be a record.
--
-- WHY A SIMULATION TARGETS A VERSION AND NOT A POLICY
--
--   ADR-0048's versioning is what gives this tool two clean, addressable
--   snapshots to diff without racing a concurrent edit. `policy_version_id` is
--   therefore NOT NULL and ON DELETE RESTRICT: a stored blast radius names the
--   exact immutable artifact it previewed, and that artifact cannot be deleted
--   out from under the preview an admin relied on when they activated.

-- ------------------------------------------------------------------------
-- policy_simulations — one dry run
-- ------------------------------------------------------------------------
--
-- `scope_user_ids` IS LOAD-BEARING, not bookkeeping. A later reader must be
-- able to tell "nothing would have flipped" from "nothing that COULD have
-- flipped was inside the caller's visibility" — those are opposite conclusions
-- from identical counts, and only the recorded scope separates them. NULL means
-- org-wide, which only an admin can obtain.
--
-- `capped` says the row cap was reached, which makes the preview a LOWER BOUND.
-- A bounded answer that admits its bound is useful; one that does not is wrong.
--
-- `fidelity_exact` / `fidelity_caveats` are derived from the CANDIDATE POLICY'S
-- OWN SOURCE — the caller never asserts its own fidelity. audit_log stores the
-- decision, not the whole decision input: no call arguments, no decision-time
-- rate counters, no session facts. A candidate that reads any of those cannot
-- be replayed exactly, and the run says so on the row rather than in a doc.

CREATE TABLE "policy_simulations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_id" uuid REFERENCES "abac_policies"("id") ON DELETE CASCADE,
  "policy_version_id" uuid NOT NULL REFERENCES "abac_policy_versions"("id") ON DELETE RESTRICT,
  "policy_name" text NOT NULL,
  "policy_version" integer NOT NULL,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "scope_user_ids" jsonb,
  "scope_rule_id" text NOT NULL,
  "window_days" integer NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "row_cap" integer NOT NULL,
  "capped" boolean DEFAULT false NOT NULL,
  "considered" integer DEFAULT 0 NOT NULL,
  "newly_denied" integer DEFAULT 0 NOT NULL,
  "newly_approval_required" integer DEFAULT 0 NOT NULL,
  "newly_allowed" integer DEFAULT 0 NOT NULL,
  "unchanged" integer DEFAULT 0 NOT NULL,
  "indeterminate" integer DEFAULT 0 NOT NULL,
  "affected_users" integer DEFAULT 0 NOT NULL,
  "affected_projects" integer DEFAULT 0 NOT NULL,
  "affected_tools" integer DEFAULT 0 NOT NULL,
  "blast_radius" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "fidelity_exact" boolean DEFAULT true NOT NULL,
  "fidelity_caveats" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "headline" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- the five buckets must account for every row examined, or the headline is
  -- arithmetic nobody can reconcile against the ledger
  CONSTRAINT "policy_simulations_buckets_ck" CHECK (
    "newly_denied" + "newly_approval_required" + "newly_allowed" + "unchanged" + "indeterminate"
      = "considered"
  ),
  CONSTRAINT "policy_simulations_window_ck" CHECK ("window_start" <= "window_end")
);
CREATE INDEX "policy_simulations_version_idx"
  ON "policy_simulations" ("policy_version_id", "created_at");
CREATE INDEX "policy_simulations_requested_idx" ON "policy_simulations" ("requested_by_user_id");

-- ------------------------------------------------------------------------
-- policy_simulation_flips — WHICH calls, exactly
-- ------------------------------------------------------------------------
--
-- "12% of traffic" without naming who is not a preview. The parent row carries
-- the full counts; these are the representative rows that make the number
-- actionable — this user, this tool, this project, this moment, allow → deny.
--
-- `audit_log_id` carries NO foreign key, for the same reason `audit_log` itself
-- carries none: the preview an admin acted on must survive the retention window
-- of the rows it cites.

CREATE TABLE "policy_simulation_flips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "simulation_id" uuid NOT NULL REFERENCES "policy_simulations"("id") ON DELETE CASCADE,
  "audit_log_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "user_label" text,
  "project_id" uuid,
  "project_name" text,
  "server_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "recorded_effect" text NOT NULL,
  "simulated_effect" text NOT NULL,
  "bucket" text NOT NULL,
  "policy_id" uuid,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "policy_simulation_flips_bucket_ck" CHECK (
    "bucket" IN ('newly_denied', 'newly_approval_required', 'newly_allowed', 'unchanged', 'indeterminate')
  ),
  CONSTRAINT "policy_simulation_flips_recorded_ck"
    CHECK ("recorded_effect" IN ('allow', 'deny', 'require_approval'))
);
CREATE INDEX "policy_simulation_flips_sim_idx" ON "policy_simulation_flips" ("simulation_id");
CREATE INDEX "policy_simulation_flips_user_idx" ON "policy_simulation_flips" ("user_id");

-- ------------------------------------------------------------------------
-- policy_simulation_settings — the friction dial ADR-0040 asked for
-- ------------------------------------------------------------------------
--
-- ADR-0040's honest-risks note: activating a policy that can deny every
-- governed call in the org should not be a one-click default. This singleton
-- turns that into an enforceable posture.
--
-- DEFAULT FALSE is a deliberate choice, not timidity: switching it on retro-
-- actively would refuse activation for every deployment that already has
-- policies and no simulation history, which is a migration that breaks running
-- installs. What is unconditional is the RECORD — the activation audit row
-- states whether a blast-radius preview of that exact version existed, so an
-- un-previewed activation is permanently legible either way.

CREATE TABLE "policy_simulation_settings" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "require_preview_before_activate" boolean DEFAULT false NOT NULL,
  "default_window_days" integer DEFAULT 30 NOT NULL,
  "default_row_cap" integer DEFAULT 5000 NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
INSERT INTO "policy_simulation_settings" ("id") VALUES ('singleton');
