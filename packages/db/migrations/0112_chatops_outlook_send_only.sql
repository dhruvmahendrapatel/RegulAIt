-- ADR-0121 — Outlook as a SEND-ONLY ChatOps provider.
--
-- Two changes, both consequences of one fact: this provider has no inbound
-- path, by decision rather than by omission.
--
-- 1. THE PROVIDER CHECK. ADR-0069 wrote `IN ('slack','teams')` into the table
--    when those were the only two. The TypeScript enum widened to include
--    'outlook' but a drizzle `text({enum})` is a compile-time constraint only,
--    so the database kept refusing the insert — registering an Outlook
--    workspace raised a CHECK violation, which the route surfaced as a 500.
--    The type said yes and the storage said no.
--
-- 2. THE SIGNING SECRET BECOMES NULLABLE. It exists to verify an inbound
--    callback's HMAC. Slack signs its bodies and the Bot Connector
--    authenticates its caller; EMAIL SIGNS NOTHING that this product could
--    verify, which is exactly why ADR-0121 refuses inbound outlook outright.
--    Requiring a secret here would have forced an operator to invent a
--    credential that is never compared against anything — a field that looks
--    like a security control and is not. NULL is the honest value: there is no
--    inbound path, so there is no secret to hold. The list endpoint reports
--    `signingSecretSet` from the column rather than hard-coding true, so a
--    reader can tell the two kinds of connection apart.
--
-- No backfill: every existing row is slack or teams and keeps its secret.

ALTER TABLE "chatops_connections"
  DROP CONSTRAINT IF EXISTS "chatops_connections_provider_ck";

ALTER TABLE "chatops_connections"
  ADD CONSTRAINT "chatops_connections_provider_ck"
  CHECK ("provider" IN ('slack', 'teams', 'outlook'));

ALTER TABLE "chatops_connections"
  ALTER COLUMN "signing_secret_ciphertext" DROP NOT NULL;

-- A secret is REQUIRED for the two providers that verify one, and REFUSED for
-- the one that cannot. Enforced in storage as well as in the route, so a
-- future caller that bypasses the route cannot create a slack connection whose
-- callbacks can never be verified, nor an outlook row carrying a dead secret.
ALTER TABLE "chatops_connections"
  ADD CONSTRAINT "chatops_connections_signing_secret_ck"
  CHECK (
    ("provider" = 'outlook' AND "signing_secret_ciphertext" IS NULL)
    OR ("provider" <> 'outlook' AND "signing_secret_ciphertext" IS NOT NULL)
  );
