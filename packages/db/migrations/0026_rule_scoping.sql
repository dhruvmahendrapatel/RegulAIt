-- PILLAR 1 rule scoping: the three restriction-rule tables (approval_rules,
-- rate_limits, data_scope_rules) stop being hard-bound to one user × one
-- server. A rule now carries a `scope` discriminant (user | role | team |
-- fleet) and a `server_scope` discriminant (server | all), so a fleet-wide
-- restriction like "any write requires approval" becomes expressible.
--
-- Existing rows backfill to scope='user', server_scope='server' with their
-- user_id/server_id intact — byte-identical behaviour, proven by the
-- unchanged single-user tests. Every rule stays a RESTRICTION evaluated AFTER
-- the grant check: a scoped rule can only ever ADD a deny/approval/cap.
--
-- approval_rules ------------------------------------------------------------
ALTER TABLE "approval_rules" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "scope" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "server_scope" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_scope_ck" CHECK (CASE scope WHEN 'user' THEN user_id IS NOT NULL WHEN 'role' THEN role_id IS NOT NULL WHEN 'team' THEN team_id IS NOT NULL WHEN 'fleet' THEN user_id IS NULL AND role_id IS NULL AND team_id IS NULL ELSE false END);--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_server_scope_ck" CHECK ((server_scope = 'server' AND server_id IS NOT NULL) OR (server_scope = 'all' AND server_id IS NULL));--> statement-breakpoint
CREATE INDEX "approval_rules_scope_idx" ON "approval_rules" USING btree ("scope","server_scope","server_id");--> statement-breakpoint
CREATE INDEX "approval_rules_role_idx" ON "approval_rules" USING btree ("role_id") WHERE "role_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "approval_rules_team_idx" ON "approval_rules" USING btree ("team_id") WHERE "team_id" IS NOT NULL;--> statement-breakpoint
-- rate_limits ---------------------------------------------------------------
ALTER TABLE "rate_limits" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_limits" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD COLUMN "scope" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD COLUMN "server_scope" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_scope_ck" CHECK (CASE scope WHEN 'user' THEN user_id IS NOT NULL WHEN 'role' THEN role_id IS NOT NULL WHEN 'team' THEN team_id IS NOT NULL WHEN 'fleet' THEN user_id IS NULL AND role_id IS NULL AND team_id IS NULL ELSE false END);--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_server_scope_ck" CHECK ((server_scope = 'server' AND server_id IS NOT NULL) OR (server_scope = 'all' AND server_id IS NULL));--> statement-breakpoint
CREATE INDEX "rate_limits_scope_idx" ON "rate_limits" USING btree ("scope","server_scope","server_id");--> statement-breakpoint
CREATE INDEX "rate_limits_role_idx" ON "rate_limits" USING btree ("role_id") WHERE "role_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "rate_limits_team_idx" ON "rate_limits" USING btree ("team_id") WHERE "team_id" IS NOT NULL;--> statement-breakpoint
-- data_scope_rules ----------------------------------------------------------
ALTER TABLE "data_scope_rules" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD COLUMN "scope" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD COLUMN "server_scope" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD CONSTRAINT "data_scope_rules_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD CONSTRAINT "data_scope_rules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD CONSTRAINT "data_scope_rules_scope_ck" CHECK (CASE scope WHEN 'user' THEN user_id IS NOT NULL WHEN 'role' THEN role_id IS NOT NULL WHEN 'team' THEN team_id IS NOT NULL WHEN 'fleet' THEN user_id IS NULL AND role_id IS NULL AND team_id IS NULL ELSE false END);--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD CONSTRAINT "data_scope_rules_server_scope_ck" CHECK ((server_scope = 'server' AND server_id IS NOT NULL) OR (server_scope = 'all' AND server_id IS NULL));--> statement-breakpoint
CREATE INDEX "data_scope_rules_scope_idx" ON "data_scope_rules" USING btree ("scope","server_scope","server_id");--> statement-breakpoint
CREATE INDEX "data_scope_rules_role_idx" ON "data_scope_rules" USING btree ("role_id") WHERE "role_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "data_scope_rules_team_idx" ON "data_scope_rules" USING btree ("team_id") WHERE "team_id" IS NOT NULL;
