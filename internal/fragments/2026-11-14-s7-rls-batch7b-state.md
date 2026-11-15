<!-- fold: state-recap -->
**2026-11-14, S7 RLS batch 7b (ADR-0234).** The runtime login cut-over: requests are served on `regulait_runtime`
(created at first boot through the owner connection when `REGULAIT_INSTALL_SECRETS_DIR` is set, or
`REGULAIT_RUNTIME_DATABASE_URL`), a member of `regulait_app` that is not a superuser, BYPASSRLS or table owner. Boot
refuses an unfit login unless `REGULAIT_DEV_PRIVILEGED_DB_LOGIN=1` (banner, audit row, posture line). The owner keeps
the migrations and the ledger prune (`audit_retention`, pending migration `rls_batch7b_runtime_cutover`). The demo job's
journeys run on the runtime login. Next: batches 3-6.
