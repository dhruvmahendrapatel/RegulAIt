<!-- fold: state-recap -->

**2026-11-16 - E22 slice 2: the pipeline builder's canvas editing UI ([ADR-0341](../decisions/0341-visual-pipeline-builder-over-workflow-templates.md), builder lane E22).**
`/admin/workflow-templates/:templateId/builder` (linked from each Workflow templates row) edits a template's draft on
a lazy `@xyflow/react` canvas (drag to reorder, drop from the palette, keyboard moves), in an Outline view (the
keyboard, screen-reader and phone path) and in a property sheet with an Advanced JSON editor, with undo and redo,
server validation after each edit and compare-and-set saves. New size-limit entries for the editor and for the graph
libraries the two canvases share; the all-JS ceiling raise is an open owner question.
