-- ADR-0062 — mode-scoped egress: make air-gapped code-enforced.
--
-- ONE COLUMN, and it can only TIGHTEN.
--
-- The deployment-wide posture ("is this installation air-gapped") is derived
-- from the ENVIRONMENT (REGULAIT_DEPLOY_MODE), not from this table, following
-- the ADR-0029 HSTS precedent: it is a deployment-shape fact an admin cannot
-- judge from a portal, and an air-gapped posture that a compromised admin
-- account could switch off from a web form would not be one.
--
-- What lives here is the ADR-0021 ceiling model's other half: an org may raise
-- the floor (a hosted or BYOC box choosing to adjudicate compiled vendor
-- endpoints) and may never lower it. Composition is MAX over
-- {permissive < strict}, so there is no value of this column that loosens an
-- air_gapped deployment.
--
-- The default 'inherit' is exactly today's behaviour, so this migration
-- changes nothing on any existing deployment.
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "egress_compiled_default_policy" text NOT NULL DEFAULT 'inherit';
