-- Migration 0057 (ADR-0045) — the MODEL RISK MANAGEMENT registry: model cards,
-- a recertification lifecycle, attachable evidence, and an OPTIONAL dispatch
-- gate that actually refuses.
--
-- WHAT THIS SCHEMA HAS TO HOLD, AND WHY EACH PIECE EXISTS
--
--  1. A MODEL CARD IS A RISK POSITION ON A MODEL-FOR-A-PURPOSE, NOT ON A
--     VENDOR. `model_cards` is keyed by (agent XOR custom provider) plus an
--     `intended_use`. The same base model used for two purposes warrants two
--     cards and two independent risk decisions — the provider-agnostic reading
--     ADR-0045 §1 asks for. The XOR is a DB CHECK, the discriminated-union
--     discipline ADR-0034 established, so a card can never claim to be about
--     both a registry agent and a self-hosted endpoint at once.
--
--  2. THE APPROVAL IS A CHAIN, NEVER AN EDITED FIELD. `model_card_approvals`
--     is append-mostly: a recertification is a NEW row that `supersedes_id`
--     points at the previous one, which is marked 'superseded' rather than
--     rewritten. "Who accepted what risk, when, and until when" therefore has
--     a durable history instead of a last-writer-wins column. There is no
--     `approved_by` column on the card itself, deliberately: putting it there
--     would invite an UPDATE and destroy the chain.
--
--  3. EXPIRY IS DATA THE GATE READS, NOT A BADGE. `valid_until` on the
--     approval row is what the dispatch gate evaluates against `now()`. The
--     stored `status` is a CACHE of that comparison, swept by an operator- or
--     cron-driven endpoint; the gate NEVER trusts it alone. That is the
--     fail-safe reading: if the sweep never runs, a lapsed approval still
--     stops dispatch, because the gate recomputes from `valid_until`. A
--     registry whose expiry depends on a scheduler nobody runs is decorative.
--
--  4. EVIDENCE IS FIRST-CLASS AND CANNOT DANGLE. `model_card_evidence` links a
--     card to an ADR-0044 `eval_runs` row (or to an external report by URL/ref).
--     The eval-run FK is ON DELETE RESTRICT: a run cited as the measured
--     evidence behind a signed-off risk decision cannot be deleted out from
--     under it, the same reasoning migration 0056 used for a scored dataset
--     version.
--
--  5. NO SECOND APPROVALS QUEUE. `model_card_approvals.approval_id` points at a
--     row in the ONE `approvals` table. The sign-off request rides the existing
--     queue, the existing decide endpoint, and the existing audit trail
--     (GOVERNANCE_LAYER_SPEC §6). `approvals.object_type` gains the value
--     'model_card' — a plain-text column with no CHECK, so no DDL, the pattern
--     ADR-0024/0034/0044 established. Same for `audit_log.object_type`.
--
--  6. THE GATE IS DEFAULT-OFF AND REVERSIBLE. `org_settings.mrm_enforced`
--     defaults to false = today's behaviour, byte-identical. Turning it on
--     makes an un-carded or lapsed model a 409 at dispatch; turning it off
--     restores dispatch and destroys no card data. That is deliberately the
--     exact shape of ADR-0024's `key_custody_enforced`.
--
-- WHAT THIS SCHEMA DOES NOT DO: it does not measure bias or fairness.
-- `bias_fairness` is a structured SLOT (ADR-0045 §2) — the place an assessment
-- is recorded and its absence is visible — not a testing engine. Nothing in
-- this migration performs an assessment, and the product must never imply it
-- does.

-- --------------------------------------------------------------------------
-- Model cards
-- --------------------------------------------------------------------------

CREATE TABLE "model_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- EXACTLY ONE of these two is non-null (CHECK below). A card is about a
  -- registry agent or about a self-hosted custom endpoint, never both.
  "agent_id" uuid,
  "custom_provider_id" uuid,
  -- the purpose the risk decision is scoped to. A second intended use is a
  -- second card, not an edit of this one.
  "intended_use" text NOT NULL,
  -- provenance / training-data / retention claims AS THE PROVIDER STATES THEM.
  -- Stored as the provider's claims, never as our verification of them.
  "data_claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "limitations" text,
  -- ADR-0045 §2: a LIST of { dimension, method, resultRef, status, assessedAt,
  -- assessedBy } slots. An empty list is a visibly INCOMPLETE card, which is
  -- the entire point — the platform requires and records an assessment, it
  -- does not perform one.
  "bias_fairness" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- e.g. ['nist-ai-rmf:MEASURE-2.11','iso-42001:8.3']. jsonb, not text[]:
  -- every array in this schema is jsonb (migration 0056's note stands).
  "standard_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "note" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_cards_subject_check" CHECK (
    ("agent_id" IS NOT NULL AND "custom_provider_id" IS NULL)
    OR ("agent_id" IS NULL AND "custom_provider_id" IS NOT NULL)
  ),
  CONSTRAINT "model_cards_intended_use_check" CHECK (length(btrim("intended_use")) > 0)
);
--> statement-breakpoint

ALTER TABLE "model_cards" ADD CONSTRAINT "model_cards_agent_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_cards" ADD CONSTRAINT "model_cards_custom_provider_id_fk"
  FOREIGN KEY ("custom_provider_id") REFERENCES "public"."custom_model_providers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_cards" ADD CONSTRAINT "model_cards_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- one card per (subject, intended use): a second risk position on the SAME
-- purpose would make "is this model approved for X" ambiguous, and an
-- ambiguous gate is not a gate. Two partial indexes because the subject is a
-- discriminated union and NULLs do not collide in a plain unique index.
CREATE UNIQUE INDEX "model_cards_agent_use_uq" ON "model_cards" USING btree ("agent_id","intended_use")
  WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "model_cards_provider_use_uq" ON "model_cards" USING btree ("custom_provider_id","intended_use")
  WHERE "custom_provider_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "model_cards_agent_idx" ON "model_cards" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "model_cards_provider_idx" ON "model_cards" USING btree ("custom_provider_id");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The approval / recertification chain
-- --------------------------------------------------------------------------

CREATE TABLE "model_card_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL,
  -- draft   : authored, not yet submitted
  -- pending : a sign-off request is LIVE in the one Approvals Queue
  -- approved: a human accepted the risk, valid until `valid_until`
  -- denied  : the sign-off request was refused
  -- expired : `valid_until` passed (swept; the gate also computes this live)
  -- revoked : explicitly withdrawn by an admin
  -- superseded: a later recertification replaced it
  "status" text NOT NULL DEFAULT 'pending',
  -- the named human whose risk acceptance this is. NOT a second entitlement
  -- surface: they decide through the ordinary /v1/approvals/:id/decide path.
  "approver_user_id" uuid NOT NULL,
  "requested_by_user_id" uuid,
  -- THE LINK TO THE ONE QUEUE. Null only for a 'draft' row that was never
  -- submitted, or after the approvals row cascaded away with its user.
  "approval_id" uuid,
  "decided_by" uuid,
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  -- the recertification date. NULL = an approval with no expiry, which the
  -- gate treats as valid indefinitely; the API refuses to create one without
  -- an explicit acknowledgement, because a never-expiring risk acceptance is
  -- exactly what recertification exists to prevent.
  "valid_until" timestamp with time zone,
  "supersedes_id" uuid,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_card_approvals_status_check" CHECK ("status" IN
    ('draft','pending','approved','denied','expired','revoked','superseded'))
);
--> statement-breakpoint

ALTER TABLE "model_card_approvals" ADD CONSTRAINT "model_card_approvals_card_id_fk"
  FOREIGN KEY ("card_id") REFERENCES "public"."model_cards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_card_approvals" ADD CONSTRAINT "model_card_approvals_approver_user_id_fk"
  FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_card_approvals" ADD CONSTRAINT "model_card_approvals_approval_id_fk"
  FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_card_approvals" ADD CONSTRAINT "model_card_approvals_supersedes_id_fk"
  FOREIGN KEY ("supersedes_id") REFERENCES "public"."model_card_approvals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "model_card_approvals_card_idx" ON "model_card_approvals" USING btree ("card_id","requested_at");
--> statement-breakpoint
CREATE INDEX "model_card_approvals_status_idx" ON "model_card_approvals" USING btree ("status","valid_until");
--> statement-breakpoint
-- at most ONE live sign-off request per card: a second concurrent request
-- would let two humans accept two different risk positions on one purpose.
CREATE UNIQUE INDEX "model_card_approvals_one_pending_uq" ON "model_card_approvals" USING btree ("card_id")
  WHERE "status" = 'pending';
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Evidence (ADR-0045 §5) — eval runs and external reports
-- --------------------------------------------------------------------------

CREATE TABLE "model_card_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL,
  -- 'eval_run' => eval_run_id set; 'external' => external_ref set (CHECK)
  "kind" text NOT NULL,
  "eval_run_id" uuid,
  "external_ref" text,
  "label" text,
  "note" text,
  "attached_by_user_id" uuid,
  "attached_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_card_evidence_kind_check" CHECK ("kind" IN ('eval_run','external')),
  CONSTRAINT "model_card_evidence_shape_check" CHECK (
    ("kind" = 'eval_run' AND "eval_run_id" IS NOT NULL AND "external_ref" IS NULL)
    OR ("kind" = 'external' AND "external_ref" IS NOT NULL AND "eval_run_id" IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_card_id_fk"
  FOREIGN KEY ("card_id") REFERENCES "public"."model_cards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- RESTRICT, not set null: a run cited as the measured evidence behind a signed
-- risk decision must not be deletable out from under it.
ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_eval_run_id_fk"
  FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_attached_by_user_id_fk"
  FOREIGN KEY ("attached_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "model_card_evidence_card_idx" ON "model_card_evidence" USING btree ("card_id");
--> statement-breakpoint
-- the same run attached twice to one card is a duplicate, not two pieces of
-- evidence
CREATE UNIQUE INDEX "model_card_evidence_run_uq" ON "model_card_evidence" USING btree ("card_id","eval_run_id")
  WHERE "eval_run_id" IS NOT NULL;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The org toggle — ADR-0024's key_custody_enforced shape, on purpose
-- --------------------------------------------------------------------------

-- false = today's behaviour, byte-identical. true = executeGovernedDispatch
-- refuses an agent with no unexpired approved card (409 mrm_approval_required),
-- audited, and fully reversible.
ALTER TABLE "org_settings" ADD COLUMN "mrm_enforced" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- how far ahead of `valid_until` a card counts as "expiring soon" — the window
-- the workbench surfaces lapses in as WORK rather than as a 3 a.m. outage.
ALTER TABLE "org_settings" ADD COLUMN "mrm_expiry_warn_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_mrm_expiry_warn_days_check"
  CHECK ("mrm_expiry_warn_days" >= 0 AND "mrm_expiry_warn_days" <= 3650);
