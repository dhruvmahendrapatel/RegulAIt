-- ADR-0022 — identity lifecycle + approver delegation + template retire +
-- persisted infra approver (enterprise-grade admin wave).
--
-- Behaviour-preserving defaults, per the 0038 invariant: every added column is
-- nullable or defaults to today's behaviour, so applying this migration
-- changes nothing until an admin acts.

-- user deactivation (deactivate != delete; audit history survives)
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;
--> statement-breakpoint

-- workflow template retire (soft-disable: no new instances; in-flight untouched)
ALTER TABLE "workflow_templates" ADD COLUMN "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "retired_reason" text;
--> statement-breakpoint

-- approver delegation windows (vacation/offboarding coverage)
CREATE TABLE "approval_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "approval_delegations_to_idx" ON "approval_delegations" USING btree ("to_user_id");
--> statement-breakpoint
CREATE INDEX "approval_delegations_from_idx" ON "approval_delegations" USING btree ("from_user_id");
--> statement-breakpoint

-- org_settings additions: delegation master switch (ON = the new behaviour is
-- available; an org that forbids delegation flips it off), and the persisted
-- default infra-remediation approver (fixes the portal's dead "Set approver").
ALTER TABLE "org_settings" ADD COLUMN "approval_delegation_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "infra_approver_user_id" uuid;
