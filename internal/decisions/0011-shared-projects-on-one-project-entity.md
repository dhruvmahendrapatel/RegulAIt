# 0011 — Shared Projects extend the one `projects` entity; conflicts ride the one approvals queue

Date: 2026-07-25
Status: Accepted

## Context

Pillar 4 (GOVERNANCE_LAYER_SPEC §9) requires a Shared Project: a governed, multi-team
container with its own membership (Owner/Contributor/Viewer, decoupled from home-team role),
a shared context store with provenance and retained versions, arbiter-routed conflict
resolution (never silent overwrite), opt-in promotion from team-local artifacts, and strict
separation from tool/connector/agent entitlement (membership widens *context*, never
capability). Pillar 5 already shipped a minimal `projects` entity for cost attribution, with
membership explicitly deferred to this pillar. The spec itself uses "Initiative/Shared
Project" as one object (§8.3 classification cascade), and §9.4 explicitly demands the
conflict inbox reuse the existing Approvals-Queue pattern.

## Decision

1. **One project entity.** Shared-Project semantics extend the existing `projects` table
   (arbiter, membership, context) rather than adding a second container. A project with
   members IS a Shared Project; a memberless project remains a plain cost-attribution bucket.
2. **Membership gates attribution.** Once a project has members, only members (or admins) may
   attribute spend/runs/instances to it; memberless projects stay open (pillar-5
   back-compat). Membership grants NO tool/connector/agent access — §2–§4 evaluation is
   untouched.
3. **Context store is append-only revisions.** Every write is a new revision carrying
   provenance (user, optional contributing team, timestamp, optional source artifact). The
   current value of a key is its highest *accepted* revision. A write based on a stale
   revision (`baseRevision` < latest) is recorded but NOT accepted: it becomes a conflict.
4. **Conflicts ride the one approvals queue.** A conflicting revision opens an approval
   (objectType `project`, stage `__context_conflict__:<itemId>`) for the project's named
   arbiter. Approve = the revision becomes the new accepted latest; deny = it stays retained
   but never current. Both sides' originals are permanent rows. A project without an arbiter
   rejects conflicting writes explicitly (422) — never silently.
5. **Promotion is a copy with provenance.** "Promote to shared" copies a workflow artifact's
   content into the context store (key = artifact output, `sourceArtifactId` set); the shared
   copy is read-only history like every revision.

## Consequences

- No second "project-like" object to keep consistent; pillar 3's classification cascade and
  pillar 5's cross-team cost rollup later attach to the same entity.
- Deferred (honest not-yet list): compliance-classification precedence + conflict surfacing
  at member-team add (§9.3/§8.3), cross-team cost rollup views (§9.5), the §9.4 suggested
  UI (Shared Projects view, contribution feed), SCIM team sync, and per-member-team default
  classifications.
