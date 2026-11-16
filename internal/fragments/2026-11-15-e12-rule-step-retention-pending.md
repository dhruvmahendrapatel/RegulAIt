<!-- fold: pending -->

**E12 / ADR-0327 — rule-step suggestions: retention, erasure and RLS (review #862, non-blocking).**
`rule_step_suggestions.rule` copies input field values out of `trace_spans` into a store that outlives trace
retention. Before the switch slice: prune or refresh suggestions whose scan window has aged out of trace retention;
register the table with the privacy-ops locator so a data-subject erasure redacts cells that hold the identifier; and
add `rule_step_settings` and `rule_step_suggestions` to the RLS batch plan with the other single-tenant tables.
Also from review #862 (second round, non-blocking): `POST /v1/rule-steps/scan` answers when the scan finishes; move it
to 202 with the scan's audit id (the console reads the audit row and suggestions) together with the scheduler entry.
