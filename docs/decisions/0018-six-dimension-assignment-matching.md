# ADR-0018 — Assignment matching: target-system + initiator-role dims (server-resolved role)

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** user (in-session), Claude
- **Relates:** pillar 2 (WORKFLOW_ENGINE_SPEC §4 assignment rules); pillar 1 (governance —
  the initiating user's identity/roles are authoritative server truth). Migration 0035.

## Context

Assignment rules (§4) route a change to the workflow template(s) that govern it. Until now a rule
could condition on three dimensions — path glob, change type, and environment — ANDed together, with
a rule that sets no condition matching nothing (never everything). The vision calls for richer
targeting: which **target system** a change lands on, which **role** the initiator holds, and the
change's **data-sensitivity**. Two of those (target-system, initiator-role) are cheap, honest wins;
the third (data-sensitivity) needs a classification substrate that isn't wired yet.

A role-based routing dimension carries a governance trap: if the initiator's role came from the
request body, any caller could self-route onto (or away from) a stricter template. Role must be
**server truth**, not client input.

## Decision

1. **Two new wired dims — five total.** `AssignmentRule` and the DB
   `workflow_assignment_rules` table gain nullable `target_system` and `initiator_role` columns
   (migration 0035). `matchTemplates` adds two more ANDed conditions — a rule with `targetSystem`
   set matches only when the change's target system equals it; a rule with `initiatorRole` set
   matches only when it is one of the initiating user's roles. The "a rule with no conditions
   matches nothing" guard is extended to include the two new fields, so an all-null rule still
   matches nothing.

2. **The kernel stays subject-free.** The kernel matches strings only: `ChangeDescriptor` gains an
   optional `targetSystem` and an optional `initiatorRoles: string[]`. It has no notion of users,
   role assignments, or auth — the gateway supplies the resolved role names.

3. **initiator-role is resolved SERVER-SIDE, never client-supplied.** The gateway, at instance
   start, reads the **authenticated** initiator's `role_assignments` → role names and injects them
   as `change.initiatorRoles` before `matchTemplates`. `changeDescriptorSchema` accepts
   `targetSystem` (a legitimate client-supplied change attribute) but **deliberately does not accept
   `initiatorRole`/`initiatorRoles`** — a client attempt to send one is ignored, and routing still
   reflects only the user's genuine roles. This is the load-bearing governance property, covered by
   a gateway e2e (a non-holder cannot smuggle the role in via the body).

4. **data-sensitivity (the 6th dim) stays deferred — stated honestly.** There is no per-change
   data-sensitivity signal to match on yet (project/initiative classifications exist, but a change
   descriptor carries no sensitivity tag), so wiring a rule dimension for it would be a condition
   nothing could satisfy. It is left out of the schema and surfaced as deferred in the admin UI.

## Consequences

- **Positive:** richer, honest routing (target-system + role) with no new authority path — a role
  rule can only fire for a real role holder; the kernel stays pure and testable; no client can
  self-route via role. Migration is a pair of nullable columns; existing rules keep matching
  unchanged. UI: the Workflows tab's rule conditions render the two new dims and the New-Run change
  form gains a target-system input.
- **Negative / deferred:** data-sensitivity remains a 6th, unwired dim pending a per-change
  sensitivity signal; initiator-role matches on role NAME (a rename would need rule updates), an
  acceptable trade for keeping the kernel subject-free.
