-- Pending migration sensitivity_labels (ADR-0252: numbered at merge). ADR-0363 slice 1 (lane E44): the customer's own
-- sensitivity labels (Microsoft Purview first) as inputs to the gateway's data-sensitivity decisions.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. Additive only.
--
--   sensitivity_label_definitions  the provider's label list, read-only, as the `idp_entra` discovery scan read it
--                                  from Graph (`security/informationProtection/sensitivityLabels`). One row per
--                                  (provider, tenant, label). A label the provider no longer lists is marked
--                                  inactive, never deleted, so a mapping row keeps its target and its history.
--                                  `parent_label_id` is the provider's own id for the parent, copied verbatim from the
--                                  provider's payload (a 3NF exception: a verbatim external reference, resolved by the
--                                  unique key, not a foreign key, because a parent can arrive after its child).
--   sensitivity_label_rules        the admin's mapping: one label -> an action (allow | redact | block), a data
--                                  sensitivity, and optionally the compliance profile whose cascade (PII mode,
--                                  guardrail floor) the labelled content pulls in. No row = the label is unmapped
--                                  and decided by `unmapped_action`.
--   sensitivity_label_settings     one row (id = true): the strict-by-default fallbacks (ADR-0180). No row is read as
--                                  all three `block`. Relaxing any of them is a `settings_relax` step-up, audited.
--
-- Deployment configuration read by every governed dispatch that carries a file, like guardrail_configs and
-- compliance_profiles: single-tenant (ADR-0041), no tenant column, so no row-level security policy of its own.
-- No functions or triggers, so the 0185 guard has nothing new to check (read by hand).

CREATE TABLE IF NOT EXISTS "sensitivity_label_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "tenant_id" text NOT NULL,
  "label_id" text NOT NULL,
  "name" text NOT NULL,
  "parent_label_id" text,
  "rank" integer,
  "active" boolean NOT NULL DEFAULT true,
  "source_id" uuid REFERENCES "discovery_sources"("id") ON DELETE SET NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sensitivity_label_definitions_uq" UNIQUE ("provider", "tenant_id", "label_id"),
  CONSTRAINT "sensitivity_label_definitions_provider_check" CHECK ("provider" IN ('microsoft_purview')),
  CONSTRAINT "sensitivity_label_definitions_guid_check" CHECK (
    "tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "label_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND ("parent_label_id" IS NULL OR "parent_label_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  CONSTRAINT "sensitivity_label_definitions_name_check" CHECK (char_length("name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sensitivity_label_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "definition_id" uuid NOT NULL REFERENCES "sensitivity_label_definitions"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "sensitivity" text NOT NULL,
  "compliance_profile_id" uuid REFERENCES "compliance_profiles"("id") ON DELETE RESTRICT,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sensitivity_label_rules_definition_uq" UNIQUE ("definition_id"),
  CONSTRAINT "sensitivity_label_rules_action_check" CHECK ("action" IN ('allow', 'redact', 'block')),
  CONSTRAINT "sensitivity_label_rules_sensitivity_check" CHECK ("sensitivity" IN ('public', 'internal', 'confidential', 'restricted'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitivity_label_rules_profile_idx" ON "sensitivity_label_rules" ("compliance_profile_id") WHERE "compliance_profile_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sensitivity_label_settings" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "unmapped_action" text NOT NULL DEFAULT 'block',
  "protected_action" text NOT NULL DEFAULT 'block',
  "unreadable_action" text NOT NULL DEFAULT 'block',
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sensitivity_label_settings_singleton_check" CHECK ("id"),
  CONSTRAINT "sensitivity_label_settings_action_check" CHECK (
    "unmapped_action" IN ('allow', 'redact', 'block')
    AND "protected_action" IN ('allow', 'redact', 'block')
    AND "unreadable_action" IN ('allow', 'redact', 'block'))
);
