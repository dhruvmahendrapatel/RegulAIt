# ADR-0206: Project archive (G1) and renaming roles and teams (G10)

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The owner approved the after-demo lifecycle proposals on 2026-10-29 (#453, comment 6509969403) and unparked them on
2026-10-30 (#453, comment 6522492997), reserving migrations 0217 and 0218 and this ADR number for G1 and G10. The
decisions, as the owner wrote them:

- **G1 Project archive.** "Admins only. Archived projects are hidden from the default list and shown behind the
  Archived chip. The dialog lists pinned engine keys that will stop working. Unarchive needs a step-up."
- **G10 Rename roles and teams.** "A reason is asked only when the old name is referenced by access policies or routing
  rules; forcing it needs a step-up."

The proposal table (comment 6509750528) adds that an archive is "refused while approvals, runs or delegations are open".
PR #604 held the approved UI on mocked routes. Before this ADR a project could not be retired at all, and a role or a
team could not be renamed.

## Decision

### G1: project archive

1. **Admin-only routes.** `GET /v1/projects/:projectId/archive-impact`, `POST /v1/projects/:projectId/archive`
   `{reason}` (10 to 500 characters) and `POST /v1/projects/:projectId/unarchive`. None is in `NON_ADMIN_ROUTES`.
2. **Archive is refused while work is open**, with the open items named (at most 50 ids, with the full count):
   `project_has_open_approvals` (pending or returned approvals attributed to the project), `project_has_running_work`
   (workflow instances not yet terminal, planned or running orchestration runs, engine runs not yet terminal) and
   `project_has_open_delegations` (unrevoked, unexpired delegation grants). A second archive is
   `project_already_archived`; unarchiving an active project is `project_not_archived`.
3. **What an archive does.** It sets `archived_at`, `archived_reason` and `archived_by_user_id` (migration 0217) and
   writes the audit row (`project-archived`, naming the reason and the pinned engine keys) in the same transaction,
   under `FOR UPDATE` on the project row. Nothing the project already holds is deleted or rewritten.
4. **An archived project takes nothing new.** The gateway answers `409 project_archived` to member adds, role changes
   and removals, context writes and promotions, the settings PATCH (including the copilot's applier, which shares its
   core) and reclassification. The pre-dispatch gate that every dispatch path calls answers the same refusal, so no
   call can be attributed to an archived project and **an engine key pinned to it stops working** without being
   revoked; it works again after an unarchive. Its budget is therefore no longer enforced: there is nothing left to
   enforce it on.
5. **The database holds the line too.** Migration 0218 adds a `BEFORE INSERT` guard on `project_members` and
   `project_context_items` that refuses a row for an archived project, reading the project row `FOR SHARE` so a write
   racing an archive either lands first (and the archive sees it) or is refused. Its function pins `search_path`
   (migration 0185). It guards INSERT only, so it is not an append-only trigger and needs no TRUNCATE guard.
6. **Hidden by default.** `GET /v1/projects` leaves archived projects out unless the caller passes
   `?archived=include` or `?archived=only`, so every project picker offers only projects that can take work. The
   projects list and the project pages ask for them and show them behind the Archived chip, with who archived the
   project and why.
7. **Unarchive needs a step-up**: a `settings_relax` grant bound to `{op: "project_unarchive", projectId}`, because it
   turns spend attribution back on. The write re-reads the row under the lock and is audited (`project-unarchived`,
   with the archive's reason and the step-up method).

### G10: rename roles and teams

8. **Admin-only routes.** `PATCH /v1/roles/:roleId` `{name, description?, reason?, acknowledgeReferences?}` and
   `PATCH /v1/teams/:teamId` `{name, reason?, acknowledgeReferences?}`. A taken name is `409 name_taken`.
9. **What matches by name.** Grants, assignments, memberships and approval routing hold a role or team by id, so a
   rename does not change them. Two things match by name:
   - an access policy whose live version (or latest version, while none is live) has the old name as a Cedar string
     literal: `principal.roles` and `principal.teams` carry names;
   - for a role, a workflow assignment (routing) rule whose `initiator_role` is the old name.
10. **A plain rename saves without a reason**, audited (`role-renamed` / `team-renamed`, from and to).
11. **A referenced rename is refused** with `409 role_name_referenced` / `team_name_referenced`, listing the policies
    and rules with their counts. The admin then sends `acknowledgeReferences: true` with a reason (`422
    rename_reason_required` without one) and a `settings_relax` step-up bound to `{op: "<noun>_rename_referenced", id,
    from, to}`, because the rename can move a forbid policy off the people it was written for. The write re-reads the
    row and the references under the row lock; if either changed, nothing is written (`409 changed_concurrently`). The
    audit row names the references, the reason and the step-up method.

### Contract

12. The bodies, refusal codes and the archive-impact view are one Zod contract in `@regulait/shared`
    (`project-archive-rename.ts`). The routes are `internal` in the stability registry.

## Consequences

- Archiving is reversible and loses nothing; it is the retirement path for a project instead of deletion.
- A rename cannot silently change who an access policy forbids: the admin sees which policies and rules match the old
  name and confirms it is them. Updating those policies remains a separate, governed edit.
- The step-up uses the existing `settings_relax` kind with an `op` naming the act, so no new kind and no org-settings
  migration were needed.

## As built (2026-10-30)

- Migrations `0217_project_archive.sql` and `0218_project_archive_write_guard.sql`, hand-written, journal `when`
  1785152000000 and 1785153000000.
- Gateway: `project-archive.ts`, `role-team-rename.ts`, and the archived check in `projects.ts`
  (`preDispatchProjectGate`, `applyProjectPatch`, the member, context and classification routes).
  Tests: `zz-adr0206-archive-rename.test.ts`.
- Web: the archive dialogs (`ProjectArchiveDialogs.tsx`) and the rename dialog are lazily loaded chunks; the projects
  list and pages read `?archived=include`. Mock spec: `e2e/g1-g10-lifecycle.mock.spec.ts`.
- Bundle: all JS 1,050 → 1,055 kB (ADR-0196 addendum, citing #453 comment 6522492997); entry ceilings unchanged.
- Open-source check (ADR-0176): no library fits. These are governance semantics (what an archive refuses, which
  references a rename must disclose) over our own tables; the database guard is plain PostgreSQL.
