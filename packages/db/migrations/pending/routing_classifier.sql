-- ADR-0353 part 2 — the pluggable routing classifier. Hand-authored (never drizzle-kit generate).
--
-- One nullable column on the org_settings singleton: the registered ADR-0088 external scorer (kind
-- `routing_complexity`) whose score picks a dispatch's complexity for routeModel. NULL = off, which every existing row
-- stays (the built-in heuristic, as before). ON DELETE SET NULL: deleting the scorer turns the classifier off, never
-- leaves a dangling reference. No index: one row.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "routing_classifier_scorer_id" uuid REFERENCES "external_scorers"("id") ON DELETE SET NULL;
