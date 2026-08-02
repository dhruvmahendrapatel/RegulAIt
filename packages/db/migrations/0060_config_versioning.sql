-- Migration 0060 (ADR-0048) — IMMUTABLE VERSIONING, CANARY ROLLOUT and
-- ONE-CLICK ROLLBACK for the governance artifacts the gateway actually reads:
-- the per-agent base system prompt (ADR-0023) and the rules-engine artifacts
-- (ADR-0027 §2).
--
-- THE CONSTRAINT THAT SHAPES EVERY LINE BELOW
--
--   An "edit" INSERTS. Nothing here is ever UPDATEd in place except the
--   `status` pointer, and even that is mirrored into an append-only activation
--   ledger. The reason is the one ADR-0048 opens with: for a product whose
--   thesis is GOVERNING AI, its own governance artifacts being mutable-in-place
--   is the sharpest self-inflicted gap — a bad prompt edit becomes an incident
--   with no rollback, no attribution and no blast-radius preview.
--
--   This deliberately follows ADR-0040's precedent (`abac_policies` +
--   `abac_policy_versions`) rather than inventing a second shape: immutable
--   version rows, an ACTIVE pointer, and activation as a pointer move. Where it
--   goes further is the CANARY status and the STAMPING below.
--
-- WHAT EACH PIECE EXISTS FOR
--
--  1. `config_versions` — one immutable row per version of one artifact,
--     keyed `(artifact_type, artifact_id, version)`. `body` is the artifact
--     verbatim (for a prompt: `{"systemPrompt": "..."}`), so a rollback is a
--     POINTER FLIP with nothing to reconstruct. Two PARTIAL UNIQUE INDEXES
--     enforce ADR-0048 §1's invariant in the database rather than in a comment:
--     at most ONE `active` and at most ONE `canary` row per artifact, always.
--     A CHECK ties `canary_pct` to the `canary` status in both directions, so a
--     percentage can neither be missing on a canary nor lingering on a promoted
--     version.
--
--  2. `config_activation_events` — the append-only record of WHICH VERSION WAS
--     ACTIVE WHEN. The `status` column on `config_versions` only tells you the
--     present; this table is what makes "which prompt governed this dispatch
--     last March" reconstructable. Promotion carries `eval_run_id` when
--     ADR-0044 gated it and `override_reason` when a human overrode the gate —
--     the honest escape hatch §4 names, recorded rather than silent.
--
--  3. Three columns on `usage_events` — THE STAMP. ADR-0048 §3: the resolved
--     version is written onto the dispatch's ledger row, so "which version
--     served this request" is a query rather than an archaeology exercise. This
--     is the whole point of the canary: a regression observed in the metrics
--     must be traceable to the version that caused it. FK-free like the rest of
--     the ledger; `config_version_int` is stored ALONGSIDE the id so the answer
--     survives even a pruned version row.
--
--  4. Behaviour-preserving backfill — every agent that has a system prompt today
--     gets `version 1, status active, label 'v1 (pre-versioning baseline)'`.
--     Nothing changes until an admin creates a v2 (ADR-0027/0038's
--     behaviour-preserving-default invariant).

-- --------------------------------------------------------------------------
-- Immutable versions
-- --------------------------------------------------------------------------

CREATE TABLE "config_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- WHICH KIND of governance artifact. Deliberately a closed vocabulary: a new
  -- artifact type is a deliberate act, not a typo in a string column.
  "artifact_type" text NOT NULL,
  "artifact_id" uuid NOT NULL,
  "version" integer NOT NULL,
  -- THE ARTIFACT, VERBATIM. This column IS the thing; rollback re-points at it
  -- and nothing is recomputed.
  "body" jsonb NOT NULL,
  "label" text,
  "parent_version" integer,
  "status" text NOT NULL DEFAULT 'draft',
  -- integer percent of traffic routed to a canary. 1..99: 0 would be a canary
  -- that never runs and 100 would be an un-audited activation.
  "canary_pct" integer,
  "author_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "config_versions_artifact_type_check" CHECK ("artifact_type" IN (
    'agent_system_prompt','agent_config','approval_rule','rate_limit',
    'data_scope_rule','compliance_profile'
  )),
  CONSTRAINT "config_versions_status_check" CHECK ("status" IN (
    'draft','canary','active','rolled_back','superseded'
  )),
  CONSTRAINT "config_versions_version_check" CHECK ("version" >= 1),
  -- the percentage and the canary status imply each other, in BOTH directions
  CONSTRAINT "config_versions_canary_pct_check" CHECK (
    ("status" = 'canary' AND "canary_pct" IS NOT NULL AND "canary_pct" BETWEEN 1 AND 99)
    OR ("status" <> 'canary' AND "canary_pct" IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_author_user_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "config_versions_artifact_version_uq"
  ON "config_versions" USING btree ("artifact_type","artifact_id","version");
--> statement-breakpoint
-- ADR-0048 §1's invariant, in the DATABASE: at most one active version per
-- artifact at any instant, and at most one canary alongside it.
CREATE UNIQUE INDEX "config_versions_one_active_uq"
  ON "config_versions" USING btree ("artifact_type","artifact_id")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "config_versions_one_canary_uq"
  ON "config_versions" USING btree ("artifact_type","artifact_id")
  WHERE "status" = 'canary';
--> statement-breakpoint
CREATE INDEX "config_versions_artifact_status_idx"
  ON "config_versions" USING btree ("artifact_type","artifact_id","status");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The append-only activation ledger
-- --------------------------------------------------------------------------

CREATE TABLE "config_activation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_type" text NOT NULL,
  "artifact_id" uuid NOT NULL,
  -- the version this event acted ON
  "version_id" uuid NOT NULL,
  "version" integer NOT NULL,
  -- what was active/canary BEFORE (null on the very first activation)
  "from_version_id" uuid,
  "from_version" integer,
  "action" text NOT NULL,
  "canary_pct" integer,
  "actor_user_id" uuid,
  "reason" text,
  -- ADR-0048 §4: the ADR-0044 run that gated a promotion, when one did
  "eval_run_id" uuid,
  -- ...and the honest escape hatch when nothing gated it
  "override" boolean DEFAULT false NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "config_activation_events_action_check" CHECK ("action" IN (
    'created','activated','canary_started','canary_adjusted','promoted','rolled_back','abandoned'
  )),
  -- an override MUST say why. An unexplained bypass of the quality gate is
  -- exactly the thing §4 refuses to allow silently.
  CONSTRAINT "config_activation_events_override_reason_check" CHECK (
    "override" = false OR ("reason" IS NOT NULL AND length("reason") > 0)
  )
);
--> statement-breakpoint

ALTER TABLE "config_activation_events" ADD CONSTRAINT "config_activation_events_version_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "public"."config_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "config_activation_events" ADD CONSTRAINT "config_activation_events_actor_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "config_activation_events" ADD CONSTRAINT "config_activation_events_eval_run_id_fk"
  FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "config_activation_events_artifact_at_idx"
  ON "config_activation_events" USING btree ("artifact_type","artifact_id","at");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- THE STAMP (ADR-0048 §3) — which version served this dispatch
-- --------------------------------------------------------------------------

ALTER TABLE "usage_events" ADD COLUMN "config_version_id" uuid;
--> statement-breakpoint
-- stored ALONGSIDE the id on purpose: the integer answer survives even if the
-- version row is later pruned, and "v7 served this" is what a human asks for.
ALTER TABLE "usage_events" ADD COLUMN "config_version" integer;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "config_canary" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "usage_events_config_version_idx"
  ON "usage_events" USING btree ("config_version_id");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- BEHAVIOUR-PRESERVING BACKFILL (ADR-0048 §7)
--
-- Every agent that carries a base system prompt TODAY becomes version 1,
-- active, authored by the migration. Nothing changes until an admin creates a
-- v2: dispatch resolves the active version, whose body is byte-identical to
-- what `agents.system_prompt` already held. An agent with NO prompt gets no
-- version row at all — inventing an empty v1 would make "has this agent ever
-- had a base prompt?" unanswerable.
-- --------------------------------------------------------------------------

INSERT INTO "config_versions" ("artifact_type","artifact_id","version","body","label","status")
SELECT 'agent_system_prompt', "id", 1,
       jsonb_build_object('systemPrompt', "system_prompt"),
       'v1 (pre-versioning baseline)',
       'active'
FROM "agents"
WHERE "system_prompt" IS NOT NULL;
--> statement-breakpoint

INSERT INTO "config_activation_events"
  ("artifact_type","artifact_id","version_id","version","action","reason")
SELECT 'agent_system_prompt', cv."artifact_id", cv."id", 1, 'activated',
       'migration 0060 backfill — the value already in agents.system_prompt, recorded as version 1 so it has a lineage to roll back TO'
FROM "config_versions" cv
WHERE cv."artifact_type" = 'agent_system_prompt' AND cv."version" = 1;
