<!-- fold: state-recap -->

**2026-11-16 - E22 slice 1: the visual pipeline builder's server side ([ADR-0341](../decisions/0341-visual-pipeline-builder-over-workflow-templates.md), builder lane E22; accepts ADR-0232's canvas design over the existing workflow templates).**
Admin routes under `/v1/workflows/builder/` open one draft per template (the live definition is recorded as version 1
the first time), save it with compare-and-set, validate it on every save (kernel schema, unknown fields, the forced
plan gate, the governed deploy tail, the create path's reference checks), diff it (RFC 6902 plus a stage summary and
the relaxations it makes), and publish it under a `settings_relax` step-up bound to the content hash, as the next
append-only version that replaces the live definition. Migration `pending/workflow_template_builder.sql` (numbered at
merge). The web canvas model (`pipelineCanvasModel.ts`) round-trips a definition byte for byte; the screens follow in
slices 2 and 3.
