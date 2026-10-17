-- The step-up kind `key_management`: rotating, revoking or retiring a signing key (the decision receipt key, the
-- token issuer's key) is bound to its own kind, so a `settings_relax` or `identity_manage` grant can never authorise a
-- key operation and a `key_management` grant authorises nothing else. Hand-authored (never drizzle-kit generate).
-- No function, trigger or table is added (the 0185 guard has nothing new to check).
--
-- Renumbered from 0207 after SD0 (migration 0202) widened the same three CHECKs for `pseudonym_reveal`: every list
-- below carries all nine kinds, `pseudonym_reveal` included. Another migration that rewrites these CHECKs must carry
-- every kind listed here as well.
ALTER TABLE "step_up_grants" DROP CONSTRAINT "step_up_grants_action_kind_check";
--> statement-breakpoint
ALTER TABLE "step_up_grants" ADD CONSTRAINT "step_up_grants_action_kind_check" CHECK (
  "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change', 'identity_manage', 'pseudonym_reveal', 'key_management')
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_action_kind_check";
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_action_kind_check" CHECK (
  "action_kind" IS NULL
  OR "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change', 'identity_manage', 'pseudonym_reveal', 'key_management')
);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT "org_settings_step_up_actions_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_actions_check" CHECK (
  jsonb_typeof("step_up_actions") = 'array'
  AND "step_up_actions" <@ '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "step_up_actions" SET DEFAULT '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb;
--> statement-breakpoint
-- first load (ADR-0180): the existing row requires the new kind too, so no key operation loses its step-up; the
-- append keeps every kind already in the row (pseudonym_reveal from 0202 included)
UPDATE "org_settings" SET "step_up_actions" = "step_up_actions" || '["key_management"]'::jsonb
  WHERE NOT ("step_up_actions" ? 'key_management');
