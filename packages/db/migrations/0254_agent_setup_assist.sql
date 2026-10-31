-- ADR-0205: the agent setup assistant's org switch (owner request 2026-10-30).
-- Hand-authored (never drizzle-kit generate). Re-runnable: the statement is idempotent.
--
-- OFF by default (ADR-0180): nothing is backfilled, so a fresh or upgraded database has the assistant off. An admin
-- turns it on through PUT /v1/org/settings, which asks a settings_relax step-up and audits the change old -> new.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "agent_setup_assist_enabled" boolean DEFAULT false NOT NULL;
