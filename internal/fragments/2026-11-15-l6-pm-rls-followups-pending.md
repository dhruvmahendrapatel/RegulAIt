<!-- fold: pending -->
**ADR-0234 PM batch follow-ups (lane L6, #828 code re-review, 2026-11-15).** The PM tables are under forced
row-level security (`rls_pm_tables`). Two follow-ups remain open:

- **The `reencrypt` CLI** (`data-key-reencrypt.ts`) walks the `pm_connections.*_ciphertext` columns with no RLS
  scope. Like the existing `users.totp_secret_ciphertext` case, this is safe only on a superuser or owner login. On
  a non-superuser login it would silently skip the PM secrets.
  - Fix: run its pass under the `migration` reason (or a dedicated key-rotation reason).
  - Fix: make it fail loudly when a table it must rewrite reads as empty.
- **`pmSyncRoute` scope.** It wraps the whole handler of each of the five non-admin PM routes, so every
  `pm_connections` row (ciphertext columns included) is visible for that handler's duration. The application
  predicate still decides what is returned.
  - Fix: narrow the step to the PM statements of each handler, so RLS stops a forgotten predicate there too.
