# ADR-0165: Use-Case Sign-Off Routing Through Named Intake Template Variants

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0080 (use-case intake front door), ADR-0077 (template gallery),
ADR-0159 (remediation approvals), demo tasks X1/X5
Migration: none

## Context

`POST /v1/use-cases` starts an instance of the newest active template named
`ai-use-case-intake`; when none exists it mints the built-in shape, whose
sign-off approver is `requesting_user` (self-review with a recorded reason).
ADR-0080's documented way to route sign-offs to a governance owner is to
create that template from the gallery with a concrete approver.

That only worked before the first use case: template names are unique even
after retirement, so once the built-in shape was minted no template of that
name could ever be created again. The real-database demo journey exposed it —
a use case registered in the UI routed its sign-off back to its proposer, and
the independent approver never saw it.

## Decision

1. The intake front door resolves the newest active template named
   `ai-use-case-intake` **or** `ai-use-case-intake/<label>` (a named variant).
   An admin routes sign-offs at any time by creating a variant from the
   `ai-use-case-intake` gallery entry with `approverUserId`; retiring it falls
   back to the previous active template.
2. Instances keep their snapshotted definition: a variant changes routing for
   NEW use cases only.
3. `demo:intake` installs `ai-use-case-intake/governance-owner` naming Avery,
   and its seeded use-case decisions are made by Avery (separation of duties),
   so the demo shows a registration landing in the approver's Inbox.

## Consequences

- No schema change; the uniqueness of template names is untouched.
- Test files that create a variant retire it in cleanup, so later files on a
  shared database still see the default routing.

## Tests

`apps/gateway/src/zz-adr0165-intake-variant.test.ts` (default routes to the
requester; a variant routes to its approver; retiring falls back);
`zz-c11-demo-check.test.ts`; the real-database `apps/web/e2e/demo-intake.spec.ts`
(Ada registers, Avery approves, the use case is approved).
