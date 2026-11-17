<!-- fold: pending -->

**E30-2 (lane E30 slice 2, PR #925 records the decision; UI for #453): the workflow start conflict policy has no screen yet.** The API is built:
`workItem` on `POST /v1/workflows/instances` (409 `workflow_start_conflict`, or 200 `reused: true` under
`use_existing`) and the org setting `workflowStartConflictPolicy` (a `settings_relax` step-up). For the design builder:
a work-item field on the intake form, the 409 shown with a link to the open instance, and the policy on the
Organisation page's workflow gates tab (`orgPageRelaxed.ts` lists it once the page edits it).
