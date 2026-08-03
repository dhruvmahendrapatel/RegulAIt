-- Migration 0058 (ADR-0046) — the REVIEW WORKBENCH: routing, SLA timers,
-- escalation, saved views and bulk actions, all as an ADDITIVE LAYER over the
-- one `approvals` table.
--
-- THE CONSTRAINT THAT SHAPES EVERY LINE BELOW
--
--   There is no second approvals store and no second decision path. By
--   deliberate design across ADR-0011/0016/0017/0027 and both specs, everything
--   needing a human decision lands in `approvals`, and "exactly one approvals
--   inbox / exactly one audit trail" is the invariant the whole product rests
--   on. So this migration adds NO column to `approvals` and NO alternative
--   queue: it adds three sidecar tables that describe WHERE an existing row
--   shows up, WHEN it is late, and WHO to widen it to when it goes stale.
--
--   Concretely: `approvals.approver_user_id` stays NOT NULL and keeps holding
--   the resolved individual (ADR-0022's approver-visibility checks and
--   ADR-0027's quorum count both read it). A role/team assignment lives in the
--   sidecar and resolves to an individual when someone CLAIMS it. An approval
--   with no matching rule keeps exactly its current single-approver behaviour,
--   byte for byte.
--
-- WHAT EACH PIECE EXISTS FOR
--
--  1. `approval_sla_policies` — a warn threshold, a breach threshold, and what
--     to do on breach. `escalate_action` admits `add_assignee | reassign |
--     notify_only` and DELIBERATELY DOES NOT ADMIT auto-approve or auto-deny.
--     A governance queue that clears itself by timeout is a bypass, and the
--     compliance-beats-approval principle (ADR-0023/0027) forbids it. That
--     absence is enforced by a CHECK constraint, not by remembering.
--
--  2. `approval_assignment_rules` — the routing table, matched on the SAME
--     dimensions ADR-0018 established for workflow assignment (object type,
--     project, data sensitivity, stage pattern, workflow template) rather than
--     a second matching vocabulary. A rule with NO conditions matches NOTHING
--     (CHECK), the same discipline `workflow_assignment_rules` follows — an
--     unconditioned rule that silently captured every approval in the
--     deployment is the failure mode that discipline exists to prevent.
--
--  3. `approval_assignments` — one row per approval (UNIQUE on approval_id).
--     Carries the routed owner, the claim state, the SLA clock (`warn_at`,
--     `due_at`), the evaluated `sla_state`, and the escalation target once a
--     breach has fired. The clock is DERIVED FROM `approvals.requested_at` and
--     the policy, so it is reconstructible: an assignment materialized late
--     computes the same deadlines an assignment materialized at creation would
--     have. That is what makes lazy evaluation honest rather than approximate.
--
--  4. `approval_saved_views` — named filter/sort presets. `user_id` NULL means
--     an admin-published shared view; the ADR's open question resolved toward
--     "per-user with an admin-publishable shared set".
--
--  5. Two `org_settings` columns fencing BULK: a hard cap on items per action,
--     and a switch that forbids bulk on approvals attributed to a project whose
--     compliance cascade demands PII blocking. Frictionless bulk approval of
--     sensitive items is precisely the rubber-stamp failure mode a governance
--     product must not ship, so the friction is the control.

-- --------------------------------------------------------------------------
-- SLA policies
-- --------------------------------------------------------------------------

CREATE TABLE "approval_sla_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- minutes from `approvals.requested_at`
  "warn_after_minutes" integer NOT NULL,
  "breach_after_minutes" integer NOT NULL,
  -- 'add_assignee' widens the queue to the escalation target (the default, and
  -- the least destructive); 'reassign' moves the named approver outright;
  -- 'notify_only' records the breach and nothing else. There is deliberately
  -- NO auto-approve and NO auto-deny — see the header.
  "escalate_action" text NOT NULL DEFAULT 'add_assignee',
  "escalate_to_kind" text,
  "escalate_to_id" uuid,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_sla_policies_window_check"
    CHECK ("warn_after_minutes" >= 0 AND "breach_after_minutes" > "warn_after_minutes"),
  CONSTRAINT "approval_sla_policies_action_check"
    CHECK ("escalate_action" IN ('add_assignee','reassign','notify_only')),
  CONSTRAINT "approval_sla_policies_kind_check"
    CHECK ("escalate_to_kind" IS NULL OR "escalate_to_kind" IN ('user','role','team')),
  -- an escalation that names nowhere to escalate TO is a breach counter, not an
  -- escalation; only 'notify_only' may omit the target
  CONSTRAINT "approval_sla_policies_target_check" CHECK (
    "escalate_action" = 'notify_only'
    OR ("escalate_to_kind" IS NOT NULL AND "escalate_to_id" IS NOT NULL)
  ),
  -- 'reassign' resolves to ONE individual; a role or a team cannot become the
  -- single NOT NULL approver_user_id
  CONSTRAINT "approval_sla_policies_reassign_check" CHECK (
    "escalate_action" <> 'reassign' OR "escalate_to_kind" = 'user'
  )
);
--> statement-breakpoint

ALTER TABLE "approval_sla_policies" ADD CONSTRAINT "approval_sla_policies_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_sla_policies_name_uq" ON "approval_sla_policies" USING btree ("name");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Routing rules
-- --------------------------------------------------------------------------

CREATE TABLE "approval_assignment_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- match conditions. NULL = "do not constrain on this dimension". They AND
  -- together, and at least one must be present (CHECK below).
  "object_type" text,
  "project_id" uuid,
  "data_sensitivity" text,
  "stage_pattern" text,
  "template_id" uuid,
  -- where a matching approval is ROUTED. This decides WHOSE QUEUE it shows in;
  -- it never decides who is ALLOWED to act — eligibility stays the §2–§6
  -- entitlement model, and a claim still resolves to a real individual.
  "assignee_kind" text NOT NULL,
  "assignee_id" uuid NOT NULL,
  -- composes with ADR-0027's per-stage quorum; 1 = today
  "quorum" integer DEFAULT 1 NOT NULL,
  -- lower wins; ties break on created_at (oldest first) so matching is total
  "priority" integer DEFAULT 100 NOT NULL,
  "sla_policy_id" uuid,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_assignment_rules_kind_check"
    CHECK ("assignee_kind" IN ('user','role','team')),
  CONSTRAINT "approval_assignment_rules_quorum_check" CHECK ("quorum" >= 1),
  -- a rule with NO conditions matches NOTHING. Same discipline as
  -- workflow_assignment_rules: an unconditioned rule would silently capture
  -- every approval in the deployment.
  CONSTRAINT "approval_assignment_rules_conditions_check" CHECK (
    "object_type" IS NOT NULL
    OR "project_id" IS NOT NULL
    OR "data_sensitivity" IS NOT NULL
    OR "stage_pattern" IS NOT NULL
    OR "template_id" IS NOT NULL
  )
);
--> statement-breakpoint

ALTER TABLE "approval_assignment_rules" ADD CONSTRAINT "approval_assignment_rules_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_assignment_rules" ADD CONSTRAINT "approval_assignment_rules_template_id_fk"
  FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_assignment_rules" ADD CONSTRAINT "approval_assignment_rules_sla_policy_id_fk"
  FOREIGN KEY ("sla_policy_id") REFERENCES "public"."approval_sla_policies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_assignment_rules" ADD CONSTRAINT "approval_assignment_rules_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "approval_assignment_rules_match_idx"
  ON "approval_assignment_rules" USING btree ("enabled","priority","created_at");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Assignments — one per approval
-- --------------------------------------------------------------------------

CREATE TABLE "approval_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "approval_id" uuid NOT NULL,
  -- NULL = no rule matched; the assignment mirrors the approval's own named
  -- approver, which is exactly today's behaviour made explicit
  "rule_id" uuid,
  "assignee_kind" text NOT NULL,
  "assignee_id" uuid NOT NULL,
  "quorum" integer DEFAULT 1 NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- a role/team assignment is claimable by any eligible member; claiming
  -- resolves it to that individual (and is audited)
  "claimed_by_user_id" uuid,
  "claimed_at" timestamp with time zone,
  -- the SLA clock, DERIVED from approvals.requested_at + the policy, so a
  -- late-materialized assignment computes the same deadlines an eagerly
  -- materialized one would have
  "sla_policy_id" uuid,
  "warn_at" timestamp with time zone,
  "due_at" timestamp with time zone,
  "sla_state" text NOT NULL DEFAULT 'ok',
  "breached_at" timestamp with time zone,
  "escalated_at" timestamp with time zone,
  "escalation_assignee_kind" text,
  "escalation_assignee_id" uuid,
  CONSTRAINT "approval_assignments_kind_check" CHECK ("assignee_kind" IN ('user','role','team')),
  CONSTRAINT "approval_assignments_quorum_check" CHECK ("quorum" >= 1),
  CONSTRAINT "approval_assignments_sla_state_check"
    CHECK ("sla_state" IN ('ok','warning','breached')),
  CONSTRAINT "approval_assignments_escalation_kind_check"
    CHECK ("escalation_assignee_kind" IS NULL OR "escalation_assignee_kind" IN ('user','role','team'))
);
--> statement-breakpoint

ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_approval_id_fk"
  FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_rule_id_fk"
  FOREIGN KEY ("rule_id") REFERENCES "public"."approval_assignment_rules"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_sla_policy_id_fk"
  FOREIGN KEY ("sla_policy_id") REFERENCES "public"."approval_sla_policies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_claimed_by_user_id_fk"
  FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- ONE assignment per approval. Two would make "whose queue is this in"
-- ambiguous and would double-count every workload aggregate.
CREATE UNIQUE INDEX "approval_assignments_approval_uq" ON "approval_assignments" USING btree ("approval_id");
--> statement-breakpoint
CREATE INDEX "approval_assignments_assignee_idx"
  ON "approval_assignments" USING btree ("assignee_kind","assignee_id");
--> statement-breakpoint
CREATE INDEX "approval_assignments_due_idx" ON "approval_assignments" USING btree ("sla_state","due_at");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Saved views
-- --------------------------------------------------------------------------

CREATE TABLE "approval_saved_views" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = an admin-PUBLISHED shared view; otherwise the owning reviewer
  "user_id" uuid,
  "name" text NOT NULL,
  "filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sort" text NOT NULL DEFAULT 'requested_at_desc',
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "approval_saved_views" ADD CONSTRAINT "approval_saved_views_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_saved_views" ADD CONSTRAINT "approval_saved_views_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "approval_saved_views_user_name_uq" ON "approval_saved_views" USING btree ("user_id","name")
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_saved_views_shared_name_uq" ON "approval_saved_views" USING btree ("name")
  WHERE "user_id" IS NULL;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Bulk fences (ADR-0046 §4)
-- --------------------------------------------------------------------------

-- a hard cap on items per bulk action. Not a UI convenience: a bulk of 5,000 is
-- indistinguishable from "approve everything".
ALTER TABLE "org_settings" ADD COLUMN "approval_bulk_max_items" integer DEFAULT 25 NOT NULL;
--> statement-breakpoint
-- true (default) = bulk is REFUSED on any approval attributed to a project
-- whose compliance cascade demands PII blocking. Reviewers with large sensitive
-- queues act item-by-item on the highest-risk classes. That friction IS the
-- control, and it is a disclosed limit rather than an oversight.
ALTER TABLE "org_settings" ADD COLUMN "approval_bulk_sensitive_blocked" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_approval_bulk_max_items_check"
  CHECK ("approval_bulk_max_items" >= 1 AND "approval_bulk_max_items" <= 500);
