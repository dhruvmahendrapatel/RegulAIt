<!-- fold: state-recap -->

**2026-11-17 - E22 follow-up: the sub-process catalogue ([ADR-0341](../decisions/0341-visual-pipeline-builder-over-workflow-templates.md) §9, Camunda gap row 10).**
Approved, reusable, versioned sub-processes (`workflow_fragments`, append-only `workflow_fragment_versions`) that
builder drafts call by pinned version (`{type: "call", fragment, version}`). Each version is decided in the Approvals
Queue (kind `workflow_fragment`) by an administrator other than its proposer. Its state is that approval row, mapped by
the kernel's declared `FRAGMENT_VERSION_STATES`, and only an approved version is listed (catalogue and template gallery)
or callable. Validate and publish expand calls into prefixed stages, so every rule and reader sees a plain definition,
and record the pins (`workflow_template_version_fragments`). Reopening a draft collapses them. Screen:
`/admin/workflow-templates/sub-processes`. Migration `pending/workflow_template_fragments.sql` (numbered at merge).
