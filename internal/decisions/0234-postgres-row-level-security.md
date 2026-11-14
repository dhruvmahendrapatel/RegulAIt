# ADR-0234: Postgres row-level security, keyed on the authenticated principal, behind a non-owner app role

- **Status**: Proposed (builder, 2026-11-06; PENDING S7)
- **Date**: 2026-11-06
- **Related**: ADR-0041 (single tenant per deployment), ADR-0060 (tamper-evident audit; follow-up 6, "DB least
  privilege / RLS"), ADR-0022 (approval delegation), ADR-0046 (approval routing), ADR-0168 (review roles), ADR-0186 A
  (approver pools), ADR-0167 (the bounded pool), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0185
  (pinned search_path), ADR-0200 (security checklist item 14)

## Context

ADR-0200's checklist item 14 asks for row-level security on tenant-scoped tables, as defence in depth behind the
application's object-level checks. ADR-0060 lists database least privilege and RLS as follow-up 6. Until this ADR no
migration enabled RLS, every runtime query ran as the table owner (a superuser in the local demo, docker-compose and
CI), and a forgotten `WHERE` was enough to return another user's rows.

**The inventory found no tenant key.** No table of the 339 in `public` (counted at the 2026-11-07 head; 329 when slice 1 was written, 338 in the whole-build review) has an `org_id` or `tenant_id` column. That is
deliberate: ADR-0041 decision 1 makes one deployment one customer and one org, and says un-`tenant_id`'d objects are the
intended shape. An `org_id` with a single value in every row would guard nothing inside a deployment. The row boundaries
that do exist inside one deployment are the user and the project. The inventory by the column that scopes each table
(from the migrated head, 2026-11-06):

| Scope | Tables | Key |
|---|---|---|
| Slice 1 (this ADR) | 4 | `users`, `auth_mfa_pending`, `approvals`, `audit_log` |
| User-owned | 49 | `user_id` / `owner_user_id` (or a delegation pair) |
| Project-scoped | 31 | `project_id`, membership in `project_members` |
| Team-scoped | 5 | `team_id`, membership in `team_members` |
| Actor-stamped only | 49 | a `created_by_user_id`-style column that records who acted, not who may read |
| Deployment-wide | 191 | none: fleet configuration, catalogues, evidence, registries |

The full table lists are in the appendix.

The owner was asked (2026-11-06) whether to key RLS on the principal and project, add an `org_id`, or do the role split
only. The answer was to take the best and most secure option; the builder recommended the principal and project key with
the role split, because it is the only option that protects real boundaries inside a single-tenant database.

## Decision

1. **The key is the authenticated principal, not an org.** Policies read two settings:
   - `regulait.user_id`: the authenticated user, from the gateway's auth context;
   - `regulait.system_context`: an explicit system reason, for paths that run before or without a principal.

   Project- and team-scoped tables (later batches) derive visibility from the principal through membership tables.
   No `org_id` column is added: that would reverse ADR-0041 decision 1 for no protection.

2. **Both settings are transaction-local, and only two wrappers set them.** `withPrincipal(db, principal, fn)` and
   `withSystemContext(db, reason, path, fn)` in `packages/db/src/rls.ts` each open their own transaction on a top-level
   handle and run one statement first:

   ```sql
   select set_config('role', 'regulait_app', true), set_config('regulait.user_id', $1, true)
   ```

   - `is_local = true` makes both die at COMMIT or ROLLBACK, so the connection goes back to the pool clean. Nothing is
     ever set at session level.
   - A wrapper takes a `Db`, never a transaction. A savepoint would keep a LOCAL setting alive after RELEASE, for the
     rest of the outer transaction, so nesting is excluded by type.
   - The principal must be a UUID and is passed as a bind parameter. A malformed value is refused before any SQL runs.

3. **Roles: the app role owns nothing, FORCE is on, and migrations run as the owner.**
   - Migration 0272 creates `regulait_app` (NOLOGIN, NOINHERIT, no BYPASSRLS). It gets SELECT, INSERT, UPDATE and
     DELETE on the tables, with default privileges for future tables. It gets no TRUNCATE, REFERENCES or TRIGGER.
   - The app role has no UPDATE or DELETE on `audit_log` and `audit_anchors` (ADR-0060 least privilege). The 0060/0185
     triggers stay as the second wall.
   - Each slice-1 table has `ENABLE` and `FORCE ROW LEVEL SECURITY`. FORCE filters the table owner too, so only a
     superuser or a BYPASSRLS role skips the policies.
   - Inside a wrapper the statements run as `regulait_app` whatever the login is. So the policies apply today, even
     though the local demo, docker-compose and CI log in as a superuser.
   - Migrations keep running as the owner. A later migration that reads or writes rows of an RLS table must first run
     `select set_config('regulait.system_context', 'migration', true)`. Otherwise, on a non-superuser owner, it touches
     zero rows. A test fails any migration after 0272 with DML on a slice-1 table that lacks the line.

4. **Background jobs and system paths use an explicit, narrow system context, never a blanket bypass.**
   - The reasons are a closed registry, identical in TypeScript (`RLS_SYSTEM_REASONS`) and in
     `regulait_rls_system_reason()`. A test compares the two. The database raises `insufficient_privilege` on any other
     value, so a typo fails loud.
   - Each reason opens only the tables whose policies name it:

   | Reason | Opens |
   |---|---|
   | `authenticate` | users (read; from batch 2 also update, never the guarded identity columns), auth_mfa_pending: sign-in and session resolution, before a principal exists |
   | `identity_provisioning` | users (all): SCIM and the seed |
   | `audit_chain` | audit_log (read): the chain writer's tip read, under the append lock |
   | `audit_verify` | audit_log (read): verification, anchoring and export jobs |
   | `approval_maintenance` | approvals (all): expiry, SLA and routing sweeps, and (batch 2) the workflow and decide steps listed in "As built (batch 2)" |
   | `rls_membership` | users (read): entered only by the SET clause of the 0272 helper functions |
   | `migration` | every slice-1 table: a later migration's data step |
   | `audit_subject` | audit_log (append, and read back its own row): batch 2, entered only by the chain writer for the INSERT of a row naming a user other than the principal |

   - `withSystemContext` refuses `rls_membership` and `migration` (they belong to SQL) and any unregistered value.

5. **"Audited" means a reviewed code path, not one audit row per transaction.**
   - Every `withSystemContext` entry is counted per reason (`rlsSystemContextCounts()`) and reported to an injectable
     sink (`setRlsSystemContextSink`), with a static path label.
   - The gateway wires the sink to its logger and metrics when it adopts the wrappers (batch 2).
   - A chained audit row per entry was rejected. `authenticate` runs on every request, and one row per request would
     drown the chain and serialise every request on the chain lock.
   - New reasons need a migration (the database registry) and a review, so the set of system paths is itself reviewed
     evidence.

6. **Secure by default: a missing setting means zero rows.**
   - `regulait_rls_user_id()` reads `nullif(current_setting('regulait.user_id', true), '')::uuid`. The `nullif` matters:
     on a connection that set the value once, a reset custom setting reads back as `''`, not NULL.
   - Every policy compares against that NULL, so with neither setting a transaction sees nothing.
   - Tests prove both cases, including on the same physical connection after a scoped transaction.

7. **Slice-1 policies.**
   - **users**: any authenticated principal may read the directory (approver pickers, display names need it). A row
     is writable by an active admin or `identity_provisioning`, and by its own user only if the new row is not admin
     and not disabled (no self-promotion, no self-re-enable). `authenticate` has no write path in slice 1. INSERT and
     DELETE need an admin or `identity_provisioning`.
   - **auth_mfa_pending**: the owning user, or `authenticate`.
   - **approvals**: a superset of every gateway visibility branch: requester, approver, named approver, decider,
     approver-role member, active delegate (ADR-0022), routing assignee by user, role or team (ADR-0046), recorded
     decider (ADR-0186 decision 26). INSERT needs `user_id` to be the principal (or an admin, or the system). The
     gateway's scope condition stays the fine-grained rule.
     - Known widening: review-role rows (ADR-0168) are visible to every principal, because review-role membership lives
       in JSON configuration, not a table. A later batch narrows this. The widening is READ-only: the review-role
       branch is not in the UPDATE policy.
   - **The write side (#682 review).** RLS cannot compare the old row with the new one, so writes are bounded three ways:
     - approvals UPDATE: `USING` is the participant predicate without the review-role branch; `WITH CHECK` requires the
       NEW row to be one the principal still takes part in, and refuses a row whose requester is the principal and whose
       approver or decider is also the principal (no routing or deciding your own request). Admins and
       `approval_maintenance` pass.
     - approvals column privileges: `regulait_app` has UPDATE on every column except `id`, `user_id`, `requested_at`,
       `named_approver_user_id`, `approver_role_id` and `review_role_id`. Nobody re-points the routing identity through
       the app role; a migration (the owner) can. A column added later is not updatable until its migration grants it.
     - audit_log INSERT: `user_id` must be the principal, unless the writer is an admin or a registered system path. A
       principal cannot forge a row about another user.
     - Residual: a participant who is not the requester (a delegate, a routed assignee, an earlier decider) may still
       set `approver_user_id` to itself. That is today's claim path (workbench claim) and is bounded to rows it already
       takes part in. A precise old-versus-new guard lands with batch 2, when the gateway's writes are wrapped.
   - **audit_log**: an admin reads everything; a principal reads the rows about itself. Any principal or system path
     may append. Nobody may update or delete.
     - The chain writer's tip and clock reads run under `audit_chain`. It is entered in the lock statement itself and
       restored right after the two reads.
     - Without this, a non-admin's append read its own last row as the tip and collided on `seq`. The probe in the
       test removes the widening and shows the unique violation.

8. **The measured cost.** Local Postgres 16, 4 vCPU. `packages/db/bench/rls-cost.mjs`: 500 users, 100,000
   approvals and 100,000 audit rows. Median of 25 runs after 5 warm-ups. "Principal" is a non-admin role member with an
   active delegation, so every branch has data.

   | Statement | Superuser (no RLS) | Principal | Admin |
   |---|---|---|---|
   | approvals, newest 100 (the queue page) | 24.7 ms | 39.9 ms | 42.4 ms |
   | approvals, `count(*)` (full scan) | 5.1 ms | 38.4 ms | 13.7 ms |
   | approvals, by primary key | 0.19 ms | 1.75 ms | 1.59 ms |
   | audit_log, newest 100 | 16.6 ms | 8.2 ms | 28.7 ms |
   | audit_log, `count(*)` | 4.9 ms | 7.7 ms | 8.4 ms |
   | users, by email | 0.15 ms | 0.93 ms | 0.58 ms |
   | the wrapper alone (`select 1`) | 0.07 ms | 0.45 ms | — |

   - The superuser column is a bare statement; the others include the wrapper's BEGIN, one `set_config` statement and
     COMMIT (about 0.4 ms).
   - A point lookup costs about 1.5 ms more, mostly the wrapper and the helper initplans. The queue page costs about
     15 ms more. The worst case, an unfiltered full scan for a non-admin, is about 7 times slower in relative terms
     (33 ms on 100,000 rows).
   - **Shape rule, from the measurement:** no correlated subquery in a policy. Every helper is wrapped as a scalar
     sub-select (one initplan per statement). Delegators and groups are arrays computed once, and assigned or decided
     approval ids come from one hashed subplan.
     - The first draft used correlated `EXISTS` and cost 17 times as much on the queue page (24.7 ms to 428 ms) and 11
       times as much for an admin. That draft never shipped.
   - The audit append gains one round trip (the context restore); the enter is folded into the lock statement.

9. **Rollout order for the remaining tables, one PR per batch, each with the same three kinds of tests.** The tests:
   cross-user blocking with the app check skipped, zero rows with no setting, and a clean pool afterwards.
   1. **Batch 2, gateway adoption.** The gateway's auth middleware runs `authenticate` reads, and requests that touch
      slice-1 tables run inside `withPrincipal`. System sweeps use `approval_maintenance` and `audit_verify`. The sink is
      wired. `RETURNING` on an audit insert needs a SELECT-visible row, so `authenticate`-time audit appends do not use
      `RETURNING`.
      - **Hard gate (#682 review):** no `authenticate` write on `users` (failed-login counters, lockout, last login,
        password rehash) is wired until a column guard lands in the same batch: either column privileges on `users`
        for a dedicated sign-in path or a guard that refuses a change to `is_admin`, `disabled_at`, `email`,
        `username`, `scim_external_id` or `cost_center` outside admin and `identity_provisioning`. The 0272 policy
        gives `authenticate` no UPDATE at all, so wiring it early fails closed.
      - **Audit attribution (#682 round 2):** some gateway appends name the subject, not the actor (for example the
        workbench routing audit, `userId: actorUserId ?? row.userId`). Under `audit_log_insert` each must write the
        actor's id or run under a named system reason. Unwrapped, it fails closed.
   2. **Batch 3, credentials.** auth_sessions, api_keys, webauthn_credentials, webauthn_challenges, step_up_grants,
      user_model_credentials, federated_identities, federated_link_requests, sso_reauth_requests,
      chat_identity_links.
   3. **Batch 4, approval satellites and membership.** approval_assignments, approval_decisions, approval_delegations,
      approval_saved_views, role_assignments, team_members, project_members. Their policies must admit `rls_membership`,
      or the 0272 helpers stop seeing memberships. Review-role membership moves into SQL here, which narrows the
      decision 7 widening.
   4. **Batch 5, project-scoped.** The 31 tables, keyed on `project_members` through a `regulait_rls_principal_projects()`
      helper: cost_events, usage_events, traces, conversations, prompts, project_context_items, and the rest.
   5. **Batch 6, the remaining user-owned and team-scoped tables** (grants, builder threads, agents, rate limits).
   6. **Batch 7, runtime cut-over.**
      - The gateway logs in as a dedicated login role that is a member of `regulait_app` (a separate connection
        string). The owner credential is used only by the migrator.
      - Boot refuses a runtime login that is a superuser or has BYPASSRLS, and the posture read reports RLS.
      - From this batch a non-superuser runtime is supported. Before it, a deployment whose runtime login is a
        non-superuser table owner (for example an RDS master user) would see zero rows on un-wrapped paths. No such
        deployment exists: the product is not live (ADR-0180), and every runtime today is the local superuser. This is
        the recorded reason for the interim state.

   **Tables added by open PRs (2026-11-06, master's instruction: listed here, their PRs not edited).** Each is
   classified again when its PR merges, by the appendix rule, and joins the named batch:

   | PR | Tables | Provisional batch |
   |---|---|---|
   | #622 | user_appearance | 6 (user-owned) |
   | #614 | model_signing_keys, model_artifact_signatures, model_artifact_supply_chain_relaxations | none (deployment-wide evidence) unless a principal key appears |
   | #628 | model_drift_settings, model_drift_monitors, model_drift_reports, model_explainability_artefacts | none (deployment-wide), or 5 if they carry `project_id` |
   | #633 | fairness_datasets, fairness_runs | 5 if they carry `project_id`, else none |
   | #604, #605, #627, #673 | no new tables (columns, guards and triggers only); a new column that names a user is checked against the table's batch | — |

   Deployment-wide (191) and actor-stamped (49) tables get no row policy: their rows are not owned by a principal. The
   app role's grants and the gateway's admin checks protect them. If a later need appears, a policy of the form
   "principal or system context is set" can be added per table.

## Threat model and limits

- RLS here defends against a missing or wrong application predicate: an object check that was skipped, a dropped
  `WHERE`, a new route that forgot the scope.
- It does not defend against code that can run arbitrary SQL on the connection. Such code can call `set_config` itself.
  Parameterised queries (ADR-0200 item 1) stay the control for that. Batch 7 removes the owner and superuser login from
  the runtime, which removes `SET ROLE` back to the owner as an escape.
- RLS is row-level. A user may update their own `users` row; `WITH CHECK` refuses a new row that is admin or disabled,
  but other columns (email, cost centre) are still guarded only by the gateway. A column-change guard is part of the
  batch 2 gate above. It is not a trigger here, because a row-level refusal trigger on `users` would bring the 0185
  TRUNCATE invariant onto a table the suites truncate.

## Rollback (back-out)

Slice 1 changes no data and no column, so backing it out is a forward migration (never an edit of 0272), run as the
owner:

1. `ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY; ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;` for users,
   auth_mfa_pending, approvals and audit_log. Every query then behaves as before 0272, wrapped or not.
2. `DROP POLICY` each slice-1 policy, then `DROP FUNCTION` the five `regulait_rls_*` helpers.
3. Keep the `regulait_app` role and its grants: a role that is a member of nothing and owns nothing is inert, and
   dropping it would fail while any wrapper still switches to it. `withPrincipal` / `withSystemContext` keep working
   (they only set settings no policy reads).
4. Revert the `audit-chain.ts` lock statement only if the settings are removed; with RLS off it is harmless.

The same steps per table back out a later batch. No backup restore is needed, because no row is changed.

## Alternatives rejected

- **An `org_id` column on every scoped table.** Reverses ADR-0041 decision 1, touches about 90 tables, and protects
  nothing while a deployment holds one org.
- **Session-level `SET` on checkout, with `RESET` on release.** A crash between the two, a missed release path or a
  pg-pool error path leaves the next borrower scoped as someone else. Transaction-local settings cannot leak.
- **A `regulait_system` role with `USING (true)` policies, or BYPASSRLS for jobs.** That is a blanket bypass. Named
  per-table reasons keep each system path to the tables it needs.
- **Policies that call a per-row visibility function.** A function with a SET clause or SECURITY DEFINER is not
  inlined; measured per-row calls were the slowest shape.
- **drizzle-orm's `pgPolicy` / `.enableRLS()` declarations (open source first, ADR-0176).** They are emitted by
  `drizzle-kit generate`, which this repo bans (CONTRIBUTING_PARALLEL_SESSIONS §4.1: it poisons the migration
  watermark). The policies are hand-written SQL. The transaction-local `set_config` pattern is the documented Postgres
  and Supabase approach; there is no library to adopt for it beyond node-postgres and drizzle, which are already used.
- **One audit row per system-context entry.** See decision 5.

## Consequences

- Wrapped paths are protected now, on every deployment, including the superuser demo. Un-wrapped paths behave exactly
  as before until batch 2.
- Every new table that is user-, project- or team-owned joins a batch. A new system path needs a registry entry in a
  migration and in `RLS_SYSTEM_REASONS`.
- A later migration's data step on an RLS table needs the `migration` context line, and a test enforces it.

## As built (slice 1)

- Migration `0272_rls_foundation_slice1` and `packages/db/src/rls.ts` (exported from `@regulait/db`).
- `audit-chain.ts` enters `audit_chain` in the lock statement and restores it after the tip and clock reads.
- `apps/gateway/src/zz-adr0234-rls-slice1.test.ts` (28 tests): inventory and roles; the registry matches;
  cross-user blocking on all four tables with the app check skipped, each with a superuser positive control; the
  participant branches; admin; zero rows with no setting, including on a reused connection; a clean pool after commit,
  after a throw and after a system context; narrow system contexts; the audit chain under a principal, with its
  negative control; the later-migration guard; the write side (a non-participant cannot decide or re-point a
  review-role row, nobody rewrites the routing identity, a requester cannot route or decide its own request but can update its own pending row, a
  principal cannot forge an audit row about another user, cannot promote itself, and `authenticate` cannot write
  users), each with positive controls.
- `packages/db/bench/rls-cost.mjs` produced the decision 8 table.

## As built (batch 2): request-scoped adoption (2026-11-07)

**Why the mechanism changed.** The batch-2 text above says requests "run inside `withPrincipal`". The gateway has
about 1,100 non-test query sites on the four slice-1 tables (users 226, approvals 120, audit_log 734,
auth_mfa_pending 10). Wrapping each is neither reviewable nor safe in one batch, and a site missed is a site
unprotected. So the scope is declared once per request and applied to every statement below it:

- **`packages/db/src/rls.ts`:** `runWithRlsPrincipal`, `runWithRlsSystem`, `runWithRlsPrincipalStep` (principal
  plus a registered reason), `runWithoutRlsScope`, `withinSystemReason` (one step inside an open `tx`), and
  `scopePoolForRls`, which `createDb` applies to every pool.
- **The scope rides an AsyncLocalStorage.** Outside a scope the pool behaves exactly as before, so the migrator,
  scripts and unadopted paths are unchanged. Inside a scope:
  - a plain statement runs as `BEGIN; set role + setting (LOCAL); <statement>; COMMIT` on one checked-out client;
  - a transaction (`pool.connect` + `BEGIN`, which is drizzle's `db.transaction`) gets the role and setting right
    after its `BEGIN`.
- **Decision 3 still holds.** Nothing is set at session level, and a client returns to the pool as it came out:
  tests prove this after a statement, a failing statement, a transaction and a failing transaction.
- **Refused or destroyed connections.** A cursor or stream inside a scope is refused, and so is `COMMIT AND CHAIN`
  or `ROLLBACK AND CHAIN` (the chained transaction would start without the transaction-local scope, as the owner).
  A client whose `ROLLBACK` failed is destroyed rather than pooled.
- **A failed scope setup (#700 review).** The `BEGIN` plus scope setup sits inside the same try as the statement, so
  a setup that fails (for example a connecting role that is not a member of `regulait_app`) is rolled back, or the
  client destroyed, and never returned to the pool aborted. After a transaction's `BEGIN` the wrapper also gives the
  client back itself on that failure, because drizzle issues `BEGIN` outside its own try/finally and would otherwise
  leak the connection; the caller's later release is a no-op and further queries on that wrapper are refused.
- **The scope helpers start a returned lazy drizzle builder inside the scope.** A builder awaited after the helper
  returned would otherwise run unscoped.

**Gateway wiring (`apps/gateway/src/app.ts`).**
- Two preHandlers bracket the auth hook. Credential resolution runs under `authenticate`. Then the request runs as
  `runWithRlsPrincipal({ userId })` to its end, or with no scope when it resolved no user: an exempt route or the
  bootstrap token.
- **Unscoped paths, recorded for batch 7.** These run exactly as before this batch: unauthenticated routes (login,
  webhooks, SCIM with its own token), bootstrap-token requests, the scheduler's sweeps, and `scheduleBackgroundWork`.
- `scheduleBackgroundWork` deliberately leaves the scope, so that work spawned by a request does not run as that
  request's principal (an approver's decision must not run the resumed builder turn as the approver).
- A detached promise that does not go through it inherits the request's scope; batch 7 audits these.

**The #682 gates, closed in migration 0313.**
- **Column guard on `users`.**
  - `authenticate` may update a user row (failed-login counters, lockout, password rehash, MFA state), but never
    `is_admin`, `disabled_at`, `email`, `username`, `scim_external_id` or `cost_center`.
  - A user editing its own row gets the same guard, minus `username`, which `POST /auth/username` lets a user
    change. This replaces slice 1's "not admin, not disabled" check and closes the threat-model note on self-edits.
  - How it works: a `STABLE` helper (`regulait_rls_users_guarded_digest`) reads the stored row in the statement's
    snapshot. It has a SET clause, so it does not recurse into the users policies, and it returns only a digest.
- **Audit attribution.**
  - `audit_log.user_id` is the sponsor or subject (ADR-0188), not necessarily the actor. An approver's decision row,
    a runner's result row and an admin action on a target user all name someone else, so binding it to the
    principal at the database contradicts the data model.
  - The chain writer, the one funnel every `insert(auditLog)` goes through, enters the new internal reason
    `audit_subject` for exactly its INSERT, and only when a row names a user other than the principal. It is decided
    in SQL from the principal the database holds, counted and reported to the sink.
  - A raw INSERT that skips the writer still has to name the principal, and the slice-1 forgery test now proves
    that path.
  - This narrows #682 finding 2 to "no forged row outside the chain writer". It is the main design point for review.
- **Approvals requester self-route guard removed.** Self-approval is decided per flow by the gateway: remediation
  and compliance-profile changes refuse it, and a governed tool call's approval may name its requester. The
  database rule refused legitimate decisions. What remains:
  - `USING` without the review-role branch;
  - `WITH CHECK` requiring the new row to stay a participant row;
  - the 0272 column privileges on the routing identity.

**Steps that act on someone else's approvals (named, greppable, counted).** These run as the principal plus
`approval_maintenance`, because their authorization is the gateway's own and the participant predicate cannot
express it until batch 4 moves review-role membership into SQL:

| Path label | What |
|---|---|
| `approvals.decide` | `decideOneApproval`: named approver, role, ADR-0168 review role, delegation, quorum and SoD are checked in code. A third user still gets the 403, not an existence-hiding 404. |
| `approvals.bulk-decide` | the bulk queue's pre-read, which feeds the same decide path |
| `approvals.lazy-sla-sweep` | the SLA and routing sweep `GET /v1/approvals` runs on read (it walks every pending row; the listing is then read back under the principal alone) |
| `workflows.stage-approval` | a stage's approval is the initiator's request, created by whoever advanced the instance |
| `workflows.supersede-gates`, `workflows.quorum-any` | a workflow effect on every pending gate of the instance |
| `engine-runs.run-approval` | an engine run's approval, queued in the run-as user's name |
| `approvals.signing-options` | the passkey signing-options route: its own eligibility check (named approver, role snapshot, delegation, queue time) is the authorization |
| `projects.context-conflicts` | the project context view's id-and-stage read of pending conflict approvals, for an already authorized member |
| `mrm.card-staleness` (`audit_verify`) | the model-risk staleness gate reads the whole ledger: any admin's or risk acceptor's change can stale a card |
| `copilot.evidence` (`audit_verify`) | the copilot answers over the ledger within the caller's copilot scope (projects and kernel-visible MCP tools) |
| `policy-simulation.replay` (`audit_verify`) | a policy simulation replays recorded traffic within the caller's simulation scope (their team, or the org for an admin) |

`runAsPrincipalStepIfScoped(reason, path, fn)` applies a step only when the request is a principal (no-op otherwise).
0313 also widens the approvals visibility superset by one branch the gateway already admits: an active delegate of an
approver-role member (`regulait_rls_delegator_groups()`, ADR-0022 x ADR-0046).

**Indexes and grants for the new policies (#700 review).** 0313 indexes every column a participant branch of
`approvals_select` / `approvals_update` compares with the principal: approvals `approver_user_id`,
`named_approver_user_id`, `decided_by` and `approver_role_id`, `approval_decisions.decider_user_id` and
`approval_assignments.escalation_assignee_id` (`assignee_id` was already covered by
`approval_assignments_assignee_idx`). `regulait_rls_users_guarded_digest` is revoked from PUBLIC and granted to
`regulait_app` alone, the role that evaluates the users policy.

**Measured (batch 2).**
- Setup: same bench, `packages/db/bench/rls-cost.mjs`, with a request-scope column. Local Postgres 16, 4 vCPU,
  100,000 approvals, median of 25.
- The request scope adds two round trips per statement (`BEGIN` plus the setting in one, `COMMIT`).

| Statement | Superuser (no RLS) | Request scope |
|---|---|---|
| approvals, newest 100 (the queue page) | 31.1 ms | 41.7 ms |
| approvals, by primary key | 0.15 ms | 0.68 ms |
| users, by email | 0.14 ms | 0.29 ms |
| a bare `select 1` | 0.12 ms | 0.34 ms |
| a request-shaped burst, 20 point reads | 3.6 ms | 19.3 ms |

- Per request this is about +0.2 to +0.8 ms a statement. A route issuing 20 statements pays about 15 ms locally,
  more on a networked database.
- The cheaper shape, one transaction per request, is rejected: it holds a connection and an open transaction for
  the life of a streaming request.
- Statement pipelining is a later optimisation if the cost shows in production traces.

**Rollout rule from #683 (master's note).**
- A migration's data step that READS a slice-1 table sees zero rows there under FORCE without the `migration`
  context. An orphan clean-up such as `... where not exists (select 1 from users ...)` would then treat every
  reference as an orphan and null it.
- A superuser migrator bypasses RLS (local and CI today), so this bites only a non-superuser owner, which is exactly
  the batch-7 runtime.
- The slice-1 later-migration guard now also fails any migration after 0272 whose data step reads a slice-1 table
  without `set_config('regulait.system_context', 'migration', true)`. #683 (and any rebase of it above 0272) must add
  that line.

**Tests.**
- `apps/gateway/src/zz-adr0234-rls-batch2.test.ts` (14 tests):
  - plain, raw and transactional statements under a scope;
  - a lazy builder;
  - concurrent scopes on one pool;
  - leaving a scope;
  - refused inputs;
  - a clean pool after every shape;
  - a failed scope setup (a login without `regulait_app`), for a plain statement and a transaction, followed by a
    working statement on the same single pooled connection;
  - `AND CHAIN` refused in a statement and inside a transaction;
  - the 0313 column guard;
  - the gateway hooks, with an unfiltered probe route for a principal and for the bootstrap token.
- The slice-1 file was updated for the 0313 policies and the extended migration guard (29 tests).
- The full gateway suite runs in CI's shards.

## As built (batch 7a): a named scope for every path with no principal (2026-11-14)

Batch 7 (the runtime cut-over) is split in two PRs so each stays reviewable. **7a** (this one) gives every path that
ran with no scope a named, closed reason. **7b** does the cut-over itself: a separate runtime login that is a member
of `regulait_app`, the owner credential for the migrator and the audit prune only, the boot refusal of a superuser or
BYPASSRLS runtime login (with a loud, audited dev opt-in), the posture read, and CI's gateway shards on the runtime
login.

Why 7a is enforced already: a scoped statement switches to `regulait_app` whatever the login is, so a path given a
scope here runs under FORCE row-level security today, on the superuser login CI uses.

**Reasons added** (pending migration `rls_batch7a_system_scopes`, and `RLS_SYSTEM_REASONS`):

| Reason | Who runs under it | users | approvals | audit_log | auth_mfa_pending |
|---|---|---|---|---|---|
| `system_task` | scheduler jobs (tick and run-now), boot tasks, the audit anchor and backup-verify timers, background work, requests from non-user credentials (engine runner, workload identity, endpoint agent, PDP) | read | all | read, append | none |
| `public_ingest` | the unauthenticated portal, ingest and webhook routes (health, trust pages, supplier portal, feedback links, agent and third-party ingest, OAuth endpoints, chat events) | read | none | append | none |
| `bootstrap_admin` | a bootstrap-token request, or a session exchanged for it | read | as an admin | as an admin | none |

- `system_task` is broad on purpose. A scheduler job acts on every row by design, and the per-job trace showed that
  model dispatch (eval drift, red team, auto-retest, builder schedules) can escalate a budget into an approval and
  count audit rows, and that several sweeps route, reopen or read approvals and the ledger. It still never writes
  `users` or touches `auth_mfa_pending`, and the ledger stays append-only (the app role has no UPDATE or DELETE on
  `audit_log`). What RLS guards is the request paths, which run as their principal or under a narrow reason.
- `public_ingest` is the narrowest, because these routes take attacker-shaped input.
- `bootstrap_admin` is admitted through `regulait_rls_is_admin()`, which now has no SET clause and reads the caller's
  reason; the principal-is-admin read moved to `regulait_rls_principal_is_admin()` (still under `rls_membership`). So
  every policy that already admitted an admin admits the bootstrap token without being re-created.
- `approval_maintenance` gains the users read, for the chat and PM callbacks that look up the deciding user.

**Wiring.**
- **Requests** (`app.ts`): a request with no user runs under `exemptRouteRlsReason(url)` for an auth-exempt route
  (`route-classes.ts`: SCIM and the identity callbacks `identity_provisioning`; other `/auth/*` routes
  `authenticate`; the PM webhook and the chat approval callback `approval_maintenance`; everything else
  `public_ingest`), `bootstrap_admin` for the bootstrap token, `system_task` for a non-user credential. Only a request
  with no credential at all, refused before any handler, stays unscoped.
- **SAML TOTP park:** the ACS runs under `identity_provisioning`, and parking the login at the TOTP step writes its
  challenge under `authenticate`.
- **Scheduler** (`scheduler.ts`): `runSchedulerJob` runs its ledger and the job under `system_task`
  (`scheduler.<job>`), whoever triggered it.
- **Boot** (`boot.ts`): every boot task after the migrations runs under `system_task` (`boot.<task>`).
  `runMigrations` stays on the owner login.
- **Timers:** the audit anchor and backup-verify timers run under `system_task`.
- **Background work** runs under `system_task` instead of no scope. A channel turn and a builder step resumed after
  an approval run as their person (the chat user's linked person, the approval's requester), not as the background.
- **Audit prune:** it deletes ledger rows and the app role has no DELETE on `audit_log`, so `runAuditPruneOnce` always
  leaves the caller's scope (the admin's POST used to run it in the admin's principal scope, which the app role
  cannot do). 7b moves it to the owner connection.
- **Chain writer:** the batch 2 `audit_subject` window (the INSERT alone, restored right after) is also entered when
  the caller's reason may append but not read the ledger (`authenticate`, `identity_provisioning`,
  `approval_maintenance`, `public_ingest`), so the writer's RETURNING of the row it appended is visible.

**Anchor state.** The anchor timer and the admin's timestamp retry now run as the app role, which 0272 gave no
UPDATE on `audit_anchors`. 7a grants UPDATE on the delivery and timestamp columns only (by column, closed for columns
added later); the anchored evidence (`id`, `seq`, `row_hash`, `head_at`, `algorithm`, `destination`, `deploy_mode`,
`created_at`) stays immutable for the app role.

**Ledger reads under a narrow reason.** Two found by the full suite: the SSO callback's sign-in-history and pre-0139
backfill lookups (`federated-identity.ts`) read the ledger under `audit_verify` rather than the callback's
`identity_provisioning`; and `audit_verify` gains the users read, so the policy simulator's replay names users for a
bootstrap-token request too.

**Still unscoped, for 7b.** `runMigrations` (owner), the audit prune (owner), the rate-limit and PM-delivery prune
timers (their tables have no RLS), and the seed, first-admin and demo scripts (they run as the migrator).

**Tests.** `zz-adr0234-rls-batch7a.test.ts` (9): what each new reason reaches with no application filter, RETURNING
under an append-only reason with the reason restored, every exempt route mapped, the scheduler and background work
under `system_task`. The batch 2 bootstrap probe now expects `bootstrap_admin`. Locally: the three RLS files and 42
affected suites (auth, SAML, OIDC, SCIM, scheduler, chat, PM, prune, boot, portals, engine runner, workload, OAuth,
builder resume, approvals; 730 tests) pass.

**Review round 1 (#809, code and security).** Both reviews blocked on one mapping: a request from a non-user
credential ran under `system_task`, which opens every approval and the whole ledger. Changes:

- **`credential_request`** (new reason) for requests from an engine runner or enrolment token, a PDP client or an
  endpoint agent: users read, ledger append (with RETURNING, through the chain writer's `audit_subject` window), and
  nothing in approvals. The one runner path that touches an approval, a failing self-test ending the engine's runs,
  supersedes each run's approval under `approval_maintenance` for that statement (`withinSystemReason`). A runner's
  result re-evaluates its workflow stage as the run's own user (`run_as_user_id`), never wider. `system_task` is now
  for principal-less server work only, never a request path. (A workload identity's request carries its sponsor as the
  user, so it was always a principal.)
- **`bootstrap_admin` is not a caller reason.** It is admin-equivalent at the database, so `runWithRlsSystem`,
  `runWithRlsPrincipalStep`, `runAsPrincipalStepIfScoped`, `withSystemContext` and `withinSystemReason` all refuse it;
  only the scope hook enters it, through `runAsBootstrapAdmin`. An `audit_verify` or `approval_maintenance` step inside
  a bootstrap scope keeps the bootstrap scope (an admin already reaches those tables), so `audit_verify` no longer
  needs, and no longer has, the users read.
- **The interception gate** (an `onRequest` hook that runs before authentication) resolves its credential and policy
  under `authenticate`.
- **Timers started inside a request** (the engine task watchdog, the discovery lease renewal, the stdio relay) run
  under `system_task` instead of inheriting the starting request's scope.
- **The scope decision is one pure function**, `requestRlsScope` in `route-classes.ts`, which the hook calls.
- **Tests** (`zz-adr0234-rls-batch7a.test.ts`, 21): the SQL registry equals the TypeScript one; every step helper
  refuses `bootstrap_admin`; `bootstrap_admin` still cannot UPDATE or DELETE the ledger; `credential_request` reads no
  ledger row and cannot read, update, delete or create an approval; `approval_maintenance` reads no ledger row;
  `audit_verify` reads no users; the scope for each non-user `via`, a user principal never in a system scope, and
  exempt routes before credentials; a census that every `setInterval` is scoped or on a reasoned allow-list, that
  `runWithoutRlsScope` has exactly two callers (the hook and the audit prune), and that only the hook enters
  `bootstrap_admin`.
- **Deferred, with the reason.** `public_ingest` keeps the users read. The unauthenticated routes that resolve a user
  (OAuth token and consent endpoints, feedback-link and portal owners, chat event senders) each read different
  columns, so a column-limited SECURITY DEFINER lookup per route is a change across those handlers. It is tracked for
  batch 8 (the users-read narrowing), and until then the users read is the only table these routes reach beyond the
  ledger append.

## Appendix: the inventory (2026-11-06, migrated head)

- **User-owned (49):** a2a_agent_grants, agent_grants, agent_revocations, agents, ai_incident_actions, ai_incidents,
  ai_policy_acknowledgements, ai_vendors, annotation_queue_reviewers, api_keys, approval_assignments,
  approval_decisions, approval_delegations, approval_saved_views, auth_sessions, bom_auditor_grants,
  builder_agent_shares, builder_channel_threads, builder_messages, builder_skills, builder_threads, builder_tool_steps,
  chat_identity_links, connector_grants, connector_revocations, connectors, federated_identities,
  federated_link_requests, governance_alerts, mcp_servers, prompt_shares, request_idempotency_keys, revocations,
  role_assignments, scim_group_members, semantic_cache, server_grants, sso_reauth_requests, step_up_grants, tool_grants,
  use_case_conditions, use_case_drafts, use_case_feedback, use_case_idempotency_keys, user_agent_policies,
  user_model_credentials, vendor_account_aliases, webauthn_challenges, webauthn_credentials. Some (agents, connectors,
  mcp_servers, ai_vendors) carry an owner column on fleet objects; each batch confirms the key before writing a policy.
- **Project-scoped (31):** ai_risks, ai_use_cases, approval_assignment_rules, builder_agents,
  config_canary_observations, conversations, copilot_queries, cost_events, delegation_grants, engine_runs, eval_runs,
  lineage_edges, lineage_nodes, model_artifacts, mrm_retest_runs, orchestration_runs, policy_simulation_flips,
  processing_records, project_context_items, project_members, prompts, redteam_runs, spend_anomalies,
  spend_monitor_policies, spend_scheduled_changes, traces, training_datasets, training_jobs, usage_events,
  virtual_keys, workflow_instances.
- **Team-scoped (5):** approval_rules, data_scope_rules, model_rate_limits, rate_limits, team_members.
- **Actor-stamped (49) and deployment-wide (191):** every other table in `public`. To regenerate every list from a
  migrated database, classify each table by its columns, in this order: `project_id`, then `team_id`, then an owner
  column (`user_id`, `owner_user_id`, `from_user_id`, `to_user_id`, `decider_user_id`, `claimed_by_user_id`), then an
  actor column (`created_by_user_id`, `requested_by_user_id`, `initiated_by_user_id`, `updated_by_user_id`,
  `decided_by_user_id`), else deployment-wide.
