<!-- fold: pending -->

**E30-6 (lane E30 incident console, ADR-0349 addition; UI for #453): the incident console has no screen yet.** The API is
built: `GET /v1/workflows/incidents` (stuck or failed instances, with the allowed actions and why not) and retry, skip
(step-up, only a check stage marked `skippable`) and cancel under `/v1/workflows/instances/:id/incident/`. For the design
builder: an incidents list on the Workflows area with the three actions, each asking for a note, and skip asking for the
step-up. Templates gain a `skippable` checkbox on check stages in the pipeline builder.
