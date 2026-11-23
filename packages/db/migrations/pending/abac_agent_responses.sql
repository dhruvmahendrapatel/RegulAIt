-- ADR-0354 — graduated, agent-steering responses on ABAC policy versions. Hand-authored (never drizzle-kit generate).
--
-- 1. `mode` admits the graduated responses beside 'forbid' and 'require_approval': 'advise' (allow with guidance),
--    'correct' (deny with a safe alternative), 'block_session' (deny and end the session) and 'disable' (deny and
--    quarantine the agent). None of them can widen access: ABAC still cannot grant (ADR-0040).
-- 2. Two nullable columns hold the static, admin-reviewed guidance a response returns to the agent. Plain text only:
--    the gateway validates it with `parseAgentGuidance` (no markup, no control characters, no placeholders, the
--    shared admission scan) and the CHECKs below repeat the bounds and the markup refusal, so a row written around
--    the API cannot store HTML or an over-long message.
-- 3. The response table's guidance rules hold in the database: advise needs a message and no alternative; correct
--    needs both; every other mode stores neither (so a `forbid` never carries hidden agent text).
-- 4. Existing rows are 'forbid' or 'require_approval' with NULL guidance, which every new CHECK already accepts:
--    nothing is backfilled and no existing decision changes.

ALTER TABLE "abac_policy_versions" ADD COLUMN IF NOT EXISTS "guidance_message" text;
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" ADD COLUMN IF NOT EXISTS "guidance_alternative" text;
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" DROP CONSTRAINT IF EXISTS "abac_policy_versions_mode_check";
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" ADD CONSTRAINT "abac_policy_versions_mode_check" CHECK (
  "mode" IN ('advise','require_approval','correct','forbid','block_session','disable')
);
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" DROP CONSTRAINT IF EXISTS "abac_policy_versions_guidance_check";
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" ADD CONSTRAINT "abac_policy_versions_guidance_check" CHECK (
  CASE "mode"
    WHEN 'advise' THEN "guidance_message" IS NOT NULL AND "guidance_alternative" IS NULL
    WHEN 'correct' THEN "guidance_message" IS NOT NULL AND "guidance_alternative" IS NOT NULL
    ELSE "guidance_message" IS NULL AND "guidance_alternative" IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" DROP CONSTRAINT IF EXISTS "abac_policy_versions_guidance_text_check";
--> statement-breakpoint
ALTER TABLE "abac_policy_versions" ADD CONSTRAINT "abac_policy_versions_guidance_text_check" CHECK (
  ("guidance_message" IS NULL OR (char_length("guidance_message") BETWEEN 1 AND 500 AND "guidance_message" !~ '[<>[:cntrl:]]'))
  AND ("guidance_alternative" IS NULL OR (char_length("guidance_alternative") BETWEEN 1 AND 300 AND "guidance_alternative" !~ '[<>[:cntrl:]]'))
);
