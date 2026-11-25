-- ADR-0357 (lane E38, slice 1c): a workflow template version written by a governance-config apply records its own
-- origin, `governance_apply`, beside `baseline` and `builder`, so the version history says which reviewed path wrote
-- it. Hand-authored (never drizzle-kit generate). Sorts after `workflow_template_builder`, which creates the table.
ALTER TABLE "workflow_template_versions" DROP CONSTRAINT "workflow_template_versions_origin_check";
--> statement-breakpoint
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_origin_check" CHECK ("origin" IN ('baseline', 'builder', 'governance_apply'));
