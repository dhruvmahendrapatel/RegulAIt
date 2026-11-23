<!-- fold: state-decisions -->

**ADR-0047 addendum (2026-11-22, owner decision; lane CX, card CXR-REV-002): a report definition is archived, never
deleted.** Deleting one used to cascade its schedules and its generated runs away. Archiving (`POST
/v1/reports/definitions/:id/archive`, admin-only; `DELETE` now does the same) moves `report_definitions.status` from
active to archived under the declared `REPORT_DEFINITION_MACHINE`, disables its schedules in the same transaction, and
writes one audit row. The sweep skips schedules of archived definitions, new generations and schedules are refused,
and every run stays readable. Archived is final (no unarchive). Migration `report_definition_archive`.
