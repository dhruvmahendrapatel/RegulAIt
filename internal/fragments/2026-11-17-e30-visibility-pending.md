<!-- fold: pending -->

**E30-5 (lane E30 slice 5, decision in PR #925; UI for #453): instance search fields and the pending-work view have no
screen yet.** The API is built: `GET /v1/workflows/instances` takes `template`, `target`, `workItem`, `owner`, `stage`,
`status` and `complianceTag` (each index-served), and `GET /v1/workflows/instances/:id/pending` says what the instance
waits for. For the design builder: the filters on the Workflows list, and a "waiting on" panel on the instance screen.
Follow-ups: a `deadline` search field once lane E21's stage SLA stores its due time as a column (today it is a
context marker, which the pending view already shows), and `describe` transitions from lane E29 in the pending view
once its state-machine helper merges.
