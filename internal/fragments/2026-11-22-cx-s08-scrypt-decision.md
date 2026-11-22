<!-- fold: state-decisions -->
**ADR-0025 addendum (lane CX, 2026-11-22; owner chose the cost): scrypt N=2^17, async, rehash on sign-in (Codex
review S-08).**
- **Cost:** new password hashes use N=2^17, r=8, p=1 (128 MiB). The previous N=2^14, p=1 was below OWASP.
- **No event-loop blocking:** hashing runs on asynchronous `crypto.scrypt`, at most four derivations at once by default
  (`p-limit` 7.3.3, MIT; `REGULAIT_PASSWORD_HASH_CONCURRENCY` 1–8; `UV_THREADPOOL_SIZE=8`). Load test: 410 ms per
  sign-in and about 12 per second per replica, with a 712 MiB peak RSS.
- **Old hashes:** they keep verifying and are re-hashed on the next successful sign-in. Out-of-range stored parameters
  are refused at the same cost as a missing hash.
- **S-10, same PR:** `runDueReportSchedules` takes an explicit `isAdmin` (no `?? true` default). The three `sql.raw`
  uuid arrays in compliance-packs, copilot and reporting are now bound parameters.
