<!-- fold: state-recap -->
**2026-11-14, S7 RLS batch 7a (ADR-0234).** Every path that ran with no RLS scope now runs under a named reason:
`system_task` (scheduler jobs, boot tasks, timers, background work; never a request path), `credential_request`
(engine runner, enrolment, PDP and endpoint-agent requests; users read and audit append only), `public_ingest`
(unauthenticated portal, ingest and webhook routes; users read and audit append only) and `bootstrap_admin` (the
bootstrap token, admitted where an admin is; not a caller reason, entered only by the scope hook). Pending migration
`rls_batch7a_system_scopes`. Channel turns and resumed builder steps run as their person; the audit prune leaves the
scope (the app role has no DELETE on the ledger). Next: 7b, the runtime login cut-over.
