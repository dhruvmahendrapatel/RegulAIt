<!-- fold: pending -->

- **Agent risk proofs, slices 2 and 3 (ADR-0345, lane E26).** Slice 2: a scheduler job that runs each due proof
  (red-team suite, the eight sandboxed gateway probes, the three ledger checks), writes the signed, chained result and
  raises an alert plus an approvals item on failure; a pack collector and posture input from the latest results.
  Slice 3: read and settings APIs, route census and a `KNOWN_UI_GAPS` entry on #453. Owner questions: a numeric
  range control on tool arguments; whether a failed proof blocks promotion; the governance review window.
