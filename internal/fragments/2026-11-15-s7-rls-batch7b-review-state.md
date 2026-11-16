<!-- fold: state-recap -->
**2026-11-15, S7 RLS batch 7b review round (ADR-0234).** Both reviews' findings closed on PR #841. The runtime-login
check now also refuses CREATEROLE and MEMBERSHIP (direct or indirect) in a superuser, BYPASSRLS, CREATEROLE or
RLS-table-owner role, for the login and for `regulait_app` itself; the RLS tables come from `pg_class.relrowsecurity`.
The login is per database (`regulait_runtime_<database>`), provisioned first (advisory lock, every other membership
revoked, password sent as a client-side SCRAM-SHA-256 verifier) and only then written to its 0600 file by rename. The
dev privileged-login opt-in is refused under a deploy signal. `audit_log_delete` is scoped `TO` the table owner; the
ADR records that system reasons are a convention, not a privilege boundary. Next: batches 3-6.
