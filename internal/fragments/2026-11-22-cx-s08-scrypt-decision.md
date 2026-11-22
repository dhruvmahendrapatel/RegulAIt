<!-- fold: state-decisions -->
**ADR-0025 addendum (lane CX, 2026-11-22): scrypt cost and async hashing (Codex review S-08).** New password hashes
use N=2^15, r=8, p=3 (32 MiB per derivation, an OWASP equivalent minimum). The previous N=2^14, p=1 was below OWASP.
Hashing now runs on asynchronous `crypto.scrypt`, so it no longer blocks the event loop. Old hashes keep verifying and
are re-hashed on the next successful password sign-in. Stored parameters outside N ≤ 2^20, r and p ≤ 64 are refused at
the same cost as a missing hash. In the same PR, S-10: `runDueReportSchedules` takes an explicit `isAdmin` (no
`?? true` default), and the three `sql.raw` uuid arrays in compliance-packs, copilot and reporting are bound
parameters. Owner question open: a higher scrypt cost.
