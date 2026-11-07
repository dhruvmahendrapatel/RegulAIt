# Pending migrations (ADR-0252)

Add a new migration here as `<slug>.sql` (lowercase words joined by `_`, for example `risk_register_owner.sql`).
Do not pick a number and do not edit `../meta/_journal.json`.

After your pull request merges, the assign-at-merge step (`scripts/assign-at-merge.mjs`, run by
`.github/workflows/assign-at-merge.yml`) gives each file here the next number, idx and `when`, renames it to
`NNNN_<slug>.sql` and appends its journal entry, in one bot pull request through the merge queue.

- Several files in one pull request are numbered in byte order of their names, so name them to sort in the order they
  must run (`rls_slice2_a_tables.sql`, `rls_slice2_b_policies.sql`).
- Refer to the migration by its slug in code and docs until it has a number.
- `runMigrations` refuses a folder with files here unless `REGULAIT_MIGRATIONS_UNASSIGNED=apply` says the database is
  disposable (CI and the test suites set it). A long-lived database waits for the numbers.

The full flow is in `internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md` §4.1.
