-- ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): the supplier-declared SPDX 3.0.1 properties.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785121000000, after 0184 (1785119000000, ADR-0188 S4)
-- and 0185 (1785120000000, guard hardening). Open source first (ADR-0176): no library applies; this is Postgres DDL.
-- Secure by default (ADR-0180): nothing here is a setting, so nothing can be relaxed; no row is written here.
--
-- `ai_bom_spdx_declarations`: one row per declared property value of ONE parent, a model card or a dataset version
-- row (`model_card_id`, `training_dataset_id` or `eval_dataset_id`; real foreign keys, R36's rule). The current value
-- of a property is the newest row (`seq`) for that parent and property; a `withdrawn` row clears it. Append-only:
-- UPDATE and DELETE are refused except the cascade of the row's own parent being deleted, and TRUNCATE is refused.
-- `declared_at` is the database clock, stamped by a trigger whatever the caller sends (M-075). The value columns are
-- typed per property and their shapes are repeated here from `@regulait/shared` (`ai-bom-spdx-fields.ts`), which
-- the write route applies first:
--   - releaseTime, builtTime  -> `value_time`, whole seconds;
--   - downloadLocation        -> `value_text`, an https ORIGIN only (R47, #280 4237493036), at most 2048 characters;
--   - packageVersion          -> `value_text`, printable ASCII with no space, `@` or `://`, at most 256;
--   - originatedBy            -> `value_text`, no control character, `@` or `://`, trimmed, at most 256;
--   - datasetType             -> `value_list`, 1 to 14 values of the SPDX 3.0.1 DatasetType vocabulary.
-- The patterns are anchored and linear (one character class, or a fixed host-and-port shape).
CREATE TABLE IF NOT EXISTS "ai_bom_spdx_declarations" (
  "seq" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "model_card_id" uuid REFERENCES "model_cards"("id") ON DELETE CASCADE,
  "training_dataset_id" uuid REFERENCES "training_datasets"("id") ON DELETE CASCADE,
  "eval_dataset_id" uuid REFERENCES "eval_datasets"("id") ON DELETE CASCADE,
  "property" text NOT NULL,
  "withdrawn" boolean DEFAULT false NOT NULL,
  "value_time" timestamp with time zone,
  "value_text" text,
  "value_list" text[],
  "source" text NOT NULL,
  "declared_by_user_id" uuid NOT NULL,
  "declared_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_bom_spdx_declarations_one_parent_check" CHECK (num_nonnulls("model_card_id", "training_dataset_id", "eval_dataset_id") = 1),
  CONSTRAINT "ai_bom_spdx_declarations_property_check" CHECK (
    ("model_card_id" IS NOT NULL AND "property" IN ('releaseTime', 'downloadLocation', 'packageVersion'))
    OR ("model_card_id" IS NULL AND "property" IN ('builtTime', 'originatedBy', 'releaseTime', 'downloadLocation', 'datasetType'))
  ),
  CONSTRAINT "ai_bom_spdx_declarations_source_check" CHECK ("source" IN ('supplier_declared', 'admin_entered')),
  CONSTRAINT "ai_bom_spdx_declarations_shape_check" CHECK (
    CASE
      WHEN "withdrawn" THEN num_nonnulls("value_time", "value_text", "value_list") = 0
      WHEN "property" IN ('releaseTime', 'builtTime') THEN "value_time" IS NOT NULL AND "value_text" IS NULL AND "value_list" IS NULL
      WHEN "property" = 'datasetType' THEN "value_list" IS NOT NULL AND "value_time" IS NULL AND "value_text" IS NULL
      ELSE "value_text" IS NOT NULL AND "value_time" IS NULL AND "value_list" IS NULL
    END
  ),
  CONSTRAINT "ai_bom_spdx_declarations_time_check" CHECK ("value_time" IS NULL OR "value_time" = date_trunc('second', "value_time")),
  CONSTRAINT "ai_bom_spdx_declarations_download_location_check" CHECK (
    "property" <> 'downloadLocation' OR "value_text" IS NULL
    OR (char_length("value_text") <= 2048 AND "value_text" ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')
  ),
  CONSTRAINT "ai_bom_spdx_declarations_package_version_check" CHECK (
    "property" <> 'packageVersion' OR "value_text" IS NULL
    OR (char_length("value_text") BETWEEN 1 AND 256 AND "value_text" ~ '^[!-~]+$'
        AND strpos("value_text", '@') = 0 AND strpos("value_text", '://') = 0)
  ),
  CONSTRAINT "ai_bom_spdx_declarations_originated_by_check" CHECK (
    "property" <> 'originatedBy' OR "value_text" IS NULL
    OR (char_length("value_text") BETWEEN 1 AND 256 AND "value_text" = btrim("value_text") AND "value_text" !~ '[[:cntrl:]]'
        AND strpos("value_text", '@') = 0 AND strpos("value_text", '://') = 0)
  ),
  CONSTRAINT "ai_bom_spdx_declarations_dataset_type_check" CHECK (
    "value_list" IS NULL
    OR (cardinality("value_list") BETWEEN 1 AND 14 AND array_position("value_list", NULL) IS NULL
        AND "value_list" <@ ARRAY['audio', 'categorical', 'graph', 'image', 'noAssertion', 'numeric', 'other', 'sensor',
                                  'structured', 'syntactic', 'text', 'timeseries', 'timestamp', 'video']::text[])
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_bom_spdx_declarations_model_card_idx" ON "ai_bom_spdx_declarations" ("model_card_id", "property", "seq" DESC) WHERE "model_card_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_bom_spdx_declarations_training_dataset_idx" ON "ai_bom_spdx_declarations" ("training_dataset_id", "property", "seq" DESC) WHERE "training_dataset_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_bom_spdx_declarations_eval_dataset_idx" ON "ai_bom_spdx_declarations" ("eval_dataset_id", "property", "seq" DESC) WHERE "eval_dataset_id" IS NOT NULL;
--> statement-breakpoint
-- the database clock, always: a caller cannot backdate or postdate a declaration (M-075)
CREATE OR REPLACE FUNCTION public.regulait_ai_bom_spdx_declaration_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.declared_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- append-only; the one DELETE admitted is the cascade of the row's own parent (that parent row is already gone)
CREATE OR REPLACE FUNCTION public.regulait_ai_bom_spdx_declaration_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND (
       (OLD."model_card_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."model_cards" WHERE "id" = OLD."model_card_id"))
    OR (OLD."training_dataset_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."training_datasets" WHERE "id" = OLD."training_dataset_id"))
    OR (OLD."eval_dataset_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."eval_datasets" WHERE "id" = OLD."eval_dataset_id"))
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'a declaration is evidence; write a new row (or a withdrawn row) instead (ADR-0189 R51)';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "ai_bom_spdx_declarations_stamp"
  BEFORE INSERT ON "ai_bom_spdx_declarations"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_ai_bom_spdx_declaration_stamp();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "ai_bom_spdx_declarations_append_only"
  BEFORE UPDATE OR DELETE ON "ai_bom_spdx_declarations"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_ai_bom_spdx_declaration_guard();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "ai_bom_spdx_declarations_no_truncate"
  BEFORE TRUNCATE ON public."ai_bom_spdx_declarations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
