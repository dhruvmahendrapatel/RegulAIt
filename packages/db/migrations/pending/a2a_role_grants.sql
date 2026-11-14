-- Lane L2 (ADR-0219 follow-up, P10): A2A role grants and per-person revocations.
-- 1. `a2a_agent_role_grants`: a role's access to a remote agent, the same shape as a direct grant (skill_id NULL = the
--    whole agent). Additive with direct grants; nobody holding the role may call until the role is assigned to them.
-- 2. `a2a_agent_revocations`: takes one person's ROLE-DERIVED access to one agent away without unassigning the role
--    (ADR-0019). A direct grant is not subtracted.
CREATE TABLE IF NOT EXISTS "a2a_agent_role_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "skill_id" text,
  "granted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "a2a_agent_role_grants_skill_check" CHECK ("skill_id" IS NULL OR char_length("skill_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_agent_role_grants_uq" ON "a2a_agent_role_grants" ("agent_id", "role_id", COALESCE("skill_id", ''));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_agent_role_grants_role_idx" ON "a2a_agent_role_grants" ("role_id", "agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_agent_revocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_agent_revocations_uq" ON "a2a_agent_revocations" ("agent_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_agent_revocations_user_idx" ON "a2a_agent_revocations" ("user_id", "agent_id");
