-- ADR-0237: native adapters for third-party guardrail providers on the external-scorer shim.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `external_scorers.adapter` (default 'regulait', the ADR-0088 contract every existing row already speaks, so the
--    default is exact rather than a backfill). The CHECK repeats EXTERNAL_SCORER_ADAPTERS in @regulait/shared.
-- 2. `external_scorers.adapter_options`: a schema-validated configuration document (vendorAdapterOptionsSchema), the
--    ADR-0200 exception for configuration jsonb. Null = the adapter's defaults.
-- 3. `external_scorers.price_per_call_usd`: the vendor's list price per call, written to usage_events.cost_usd on every
--    successful call. Null = unpriced. A negative price is refused.
-- No row changes its enablement: a vendor adapter is only ever enabled through the API, behind step-up.

ALTER TABLE "external_scorers" ADD COLUMN IF NOT EXISTS "adapter" text DEFAULT 'regulait' NOT NULL;
--> statement-breakpoint
ALTER TABLE "external_scorers" ADD COLUMN IF NOT EXISTS "adapter_options" jsonb;
--> statement-breakpoint
ALTER TABLE "external_scorers" ADD COLUMN IF NOT EXISTS "price_per_call_usd" double precision;
--> statement-breakpoint
ALTER TABLE "external_scorers" DROP CONSTRAINT IF EXISTS "external_scorers_adapter_check";
--> statement-breakpoint
ALTER TABLE "external_scorers" ADD CONSTRAINT "external_scorers_adapter_check"
  CHECK ("adapter" IN ('regulait', 'openai_moderation', 'azure_content_safety', 'lakera_guard'));
--> statement-breakpoint
ALTER TABLE "external_scorers" DROP CONSTRAINT IF EXISTS "external_scorers_price_per_call_usd_check";
--> statement-breakpoint
ALTER TABLE "external_scorers" ADD CONSTRAINT "external_scorers_price_per_call_usd_check"
  CHECK ("price_per_call_usd" IS NULL OR "price_per_call_usd" >= 0);
--> statement-breakpoint
ALTER TABLE "external_scorers" DROP CONSTRAINT IF EXISTS "external_scorers_adapter_options_check";
--> statement-breakpoint
ALTER TABLE "external_scorers" ADD CONSTRAINT "external_scorers_adapter_options_check"
  CHECK ("adapter_options" IS NULL OR jsonb_typeof("adapter_options") = 'object');
