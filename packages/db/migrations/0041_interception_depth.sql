-- ADR-0024 — interception DEPTH (ROADMAP §6 items O11, O13, O15): the
-- difference between "we intercept" and "we can't be bypassed".
--
-- O11 — require_mcp_attribution: the MCP twin of the compat surfaces'
-- require_project_attribution. Default FALSE = today's behaviour (an
-- unattributed MCP call runs, now METERED with project_id NULL — the metering
-- change is code, not DDL, because usage_events.project_id was already
-- nullable). TRUE = an MCP call without x-regulait-project-id is rejected
-- pre-dispatch with an error naming the header, and audited.
ALTER TABLE "interception_settings" ADD COLUMN "require_mcp_attribution" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- O15 — key_custody_enforced: the key_custody rung stops being merely DECLARED.
-- Default FALSE = today (the posture drives UI warnings only). TRUE = per-user
-- BYO model credentials stop working: creation/update is a 409 and dispatch
-- resolution SKIPS stored per-user credentials entirely (org/platform
-- credentials only). Existing user credential rows are NOT deleted — they are
-- inert while enforced, so flipping the toggle back restores them (reversible).
ALTER TABLE "interception_settings" ADD COLUMN "key_custody_enforced" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- O13 — per-role / per-project / per-user interception overrides, so an admin
-- can pilot a compat surface with one team instead of flipping the org-wide
-- singleton. NULL on any override column = inherit from the next level down.
-- Precedence: user > project > role > org singleton; FIRST NON-NULL PER FIELD
-- wins; ties within a kind resolve to the MOST RECENTLY CREATED rule.
-- scope_id is polymorphic (a users.id, projects.id, or roles.id depending on
-- scope_kind), so no FK — existence is validated at the API, and a dangling
-- rule simply never matches anything.
CREATE TABLE "interception_scope_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"anthropic_compat_enabled" boolean,
	"openai_compat_enabled" boolean,
	"resolution_mode" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interception_scope_rules_kind" CHECK ("interception_scope_rules"."scope_kind" IN ('user', 'project', 'role'))
);
--> statement-breakpoint
CREATE INDEX "interception_scope_rules_scope_idx" ON "interception_scope_rules" ("scope_kind", "scope_id");
