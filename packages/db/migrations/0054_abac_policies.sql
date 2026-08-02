-- Migration 0054 (ADR-0040) — ABAC / policy-as-code on the kernel allow path.
--
-- Attribute-conditional policy, written in Cedar, evaluated IN-PROCESS
-- (@cedar-policy/cedar-wasm — no sidecar, works air-gapped) INSIDE the existing
-- policy kernel rather than beside it. The shape below exists to hold four
-- invariants that the ADR states and the kernel tests lock:
--
--  1. ABAC NEVER GRANTS. There is no column here that can widen entitlement.
--     `mode` is CHECK-constrained to ('forbid','require_approval') — the two
--     things a policy may do to a call the RBAC layer ALREADY allowed. A Cedar
--     `permit` is refused at write time by the engine wrapper's validator, not
--     accepted and silently ignored.
--  2. EMPTY POLICY SET = TODAY. Both tables start empty, `enabled` defaults to
--     FALSE, and `active_version_id` starts NULL — so a fresh install evaluates
--     exactly as it did before this migration. The upgrade is invisible.
--  3. EVERY ACTIVATION IS A VERSION BUMP, AND HISTORY IS IMMUTABLE. See the
--     two-table split below.
--  4. TIME IS EVALUATED IN A DECLARED ZONE. `timezone` is NOT NULL with a 'UTC'
--     default and lives on the VERSION row, so "22:00" means the same thing on
--     every host that evaluates that policy version, forever.
--
-- ---------------------------------------------------------------------------
-- THE VERSIONING SHAPE, AND WHY IT IS TWO TABLES
-- ---------------------------------------------------------------------------
-- A single table carrying (source, version, enabled) would have to be UPDATEd
-- in place to change a policy, which destroys exactly the thing a governance
-- surface exists to preserve: the ability to answer "what did this policy say
-- on the day that call was denied?" and to roll back to it.
--
-- So:
--   * `abac_policies` is the stable IDENTITY of a policy — its name, whether it
--     is in the active set at all, and a POINTER to whichever version is
--     currently live. Its `id` is what lands in a decision's `ruleId`, in the
--     `abac-forbid` rule-chain entry and in the `approvals.rule_id` of a paused
--     call, so it must survive every edit.
--   * `abac_policy_versions` rows are IMMUTABLE. Editing a policy INSERTs a new
--     version (version = max + 1); it never UPDATEs an existing one. Activating
--     is a single UPDATE of `abac_policies.active_version_id`, audited.
--     ROLLBACK IS THE SAME OPERATION pointed at an older row — v2 keeps
--     existing after a rollback to v1, so the history is intact and the
--     rollback is itself revertible.
--
-- The FK from the pointer to the version row is added AFTER both tables exist
-- (it is circular by construction) and is ON DELETE SET NULL: losing the
-- pointer must deactivate the policy, never cascade-delete the policy itself.

CREATE TABLE "abac_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- The activation switch. FALSE (the default, and the state every newly
  -- created policy starts in) means the policy is not evaluated at all — an
  -- admin must deliberately activate a version, which is the ADR's
  -- "activating a forbid without previewing its blast radius should be
  -- friction, not a one-click default".
  "enabled" boolean DEFAULT false NOT NULL,
  "active_version_id" uuid,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "abac_policies_name_uq" UNIQUE("name")
);
--> statement-breakpoint

CREATE TABLE "abac_policy_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_id" uuid NOT NULL,
  -- monotonically increasing per policy; 1 is the first draft
  "version" integer NOT NULL,
  -- the Cedar policy text, exactly as the author wrote it. Exportable to a
  -- customer's own repo (pillar 1 §5, "governance is version-controlled,
  -- code-reviewed, deployed like infra") — this column IS the artifact.
  "source" text NOT NULL,
  -- which version of the ATTRIBUTE SCHEMA this source was validated against. A
  -- policy referencing an attribute the schema does not declare is refused at
  -- WRITE time, so this column is what makes that check reproducible later.
  "schema_version" text NOT NULL,
  -- what happens when the policy matches. Deliberately NOT nullable and
  -- deliberately without an 'allow' member: see invariant 1 above.
  "mode" text NOT NULL,
  -- the IANA zone the policy's time-of-day attributes are computed in, NEVER
  -- the server's incidental locale and never a client clock (ADR-0040 honest
  -- risk #2).
  "timezone" text DEFAULT 'UTC' NOT NULL,
  -- required when mode='require_approval': the Approvals-Queue approver a
  -- paused call is routed to. It is the SAME queue every rule-driven approval
  -- uses (approvals.rule_id carries this policy's id), not a parallel one.
  "approver_user_id" uuid,
  -- ADR-0040 "Testable": policy unit tests travel WITH the policy version, so
  -- a change that flips an existing expectation is caught before it ships.
  -- Shape: [{ name, request: {principal, resource, context, at}, expect }]
  "test_cases" jsonb,
  "author_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "abac_policy_versions_mode_check" CHECK ("mode" IN ('forbid','require_approval')),
  CONSTRAINT "abac_policy_versions_approver_check"
    CHECK ("mode" <> 'require_approval' OR "approver_user_id" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "abac_policy_versions" ADD CONSTRAINT "abac_policy_versions_policy_id_fk"
  FOREIGN KEY ("policy_id") REFERENCES "public"."abac_policies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" ADD CONSTRAINT "abac_policy_versions_approver_user_id_fk"
  FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" ADD CONSTRAINT "abac_policy_versions_author_user_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "abac_policies" ADD CONSTRAINT "abac_policies_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- the circular pointer, added last. SET NULL, never CASCADE: see above.
ALTER TABLE "abac_policies" ADD CONSTRAINT "abac_policies_active_version_id_fk"
  FOREIGN KEY ("active_version_id") REFERENCES "public"."abac_policy_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "abac_policy_versions_policy_version_uq" ON "abac_policy_versions" USING btree ("policy_id","version");
--> statement-breakpoint
CREATE INDEX "abac_policy_versions_policy_idx" ON "abac_policy_versions" USING btree ("policy_id","version" DESC);
--> statement-breakpoint
-- the hot path: "load the active policy set" is one indexed scan, and an
-- install with no ABAC policies never leaves this index.
CREATE INDEX "abac_policies_enabled_idx" ON "abac_policies" USING btree ("enabled");
