-- ADR-0202 lane E — Resend as a SEND-ONLY ChatOps provider (mail, like
-- outlook under ADR-0121). Hand-written; never `drizzle-kit generate`.
--
-- 1. THE PROVIDER CHECK widens to 'resend'. The drizzle enum is compile-time
--    only, so without this the insert would be refused by storage (0112).
-- 2. THE SIGNING SECRET is forbidden on resend, as on outlook: mail has no
--    inbound path, so there is nothing for a secret to verify.
-- 3. A RESEND ROW NAMES NO RECIPIENT. Its mail goes to the approval's named
--    approver (or the alert's owner), so `default_channel` holds the fixed
--    marker 'named-approvers', enforced here as well as in the route.
--
-- No backfill: no existing row is resend.

ALTER TABLE "chatops_connections" DROP CONSTRAINT IF EXISTS "chatops_connections_provider_ck";
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_provider_ck"
  CHECK ("provider" IN ('slack', 'teams', 'outlook', 'resend'));
--> statement-breakpoint
ALTER TABLE "chatops_connections" DROP CONSTRAINT IF EXISTS "chatops_connections_signing_secret_ck";
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_signing_secret_ck"
  CHECK (
    ("provider" IN ('outlook', 'resend') AND "signing_secret_ciphertext" IS NULL)
    OR ("provider" = 'teams' AND ("signing_secret_ciphertext" IS NOT NULL OR "bot_app_id" IS NOT NULL))
    OR ("provider" NOT IN ('outlook', 'resend', 'teams') AND "signing_secret_ciphertext" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_resend_recipient_check"
  CHECK ("provider" <> 'resend' OR "default_channel" = 'named-approvers');
