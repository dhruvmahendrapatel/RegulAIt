<!-- fold: state -->

**E15 — detection suppressions and dry run (2026-11-21, ADR-0333 §5b).** Per-rule, per-group suppressions with an expiry
(created behind a `settings_relax` step-up bound to their terms; suppressed matches still counted in audit rows), and a
read-only dry run of the active or a proposed pack over a past window (at most 7 days, 20,000 rows). API only; screens on
#453. Open: device-side delivery of quarantine (lane E13); E19 to import `killSwitchNarrowingOnly`.
