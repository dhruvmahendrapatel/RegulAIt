<!-- fold: state-decisions -->

ADR-0348 (lane E29 brief, 2026-11-17): every lifecycle column gets one typed transition table in
`packages/shared/src/state-machines.ts`; every writer guards its UPDATE on the event's source states; API responses carry
a read-only `lifecycle` view that the UI and agents read instead of re-deriving rules. A plain table, not XState, for
server lifecycles; the UI uses the same machine through the API with no client library.
