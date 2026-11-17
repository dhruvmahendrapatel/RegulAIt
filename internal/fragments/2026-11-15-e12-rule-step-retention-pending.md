<!-- fold: pending -->

**E12 / ADR-0327 — rule-step suggestions: retention, erasure and RLS — DONE in slice 3 (first part).** Suggestions
are pruned on the §8.3 floor with traces, located and deleted by a data-subject erasure, and classified deployment-wide
in ADR-0234.
Also from review #862 (second round, non-blocking): `POST /v1/rule-steps/scan` answers when the scan finishes; move it
to 202 with the scan's audit id (the console reads the audit row and suggestions) together with the scheduler entry.
