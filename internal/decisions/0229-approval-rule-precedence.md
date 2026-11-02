# ADR-0229: Approval-rule precedence — the most specific matching rule names the approver

- **Status**: Accepted (builder, 2026-11-02; bug found on the AWS demo host, #453 comments around 01:00–01:55 UTC)
- **Date**: 2026-11-02
- **Related**: ADR-0104 (approval scope, strictest wins), ADR-0180 (secure by default), ADR-0186 A (quorum and the
  approver pool), ADR-0210 (simulation parity for approval quorums), ADR-0228 (the demo host)

## Context

When several approval rules match one governed call, the kernel reported `matchingApprovalRules(...)[0]` as the
pausing rule. That rule names the approver and, in the gateway, the approver role whose active members form the
signing pool (ADR-0186 A). The gateway loaded the rules with no `ORDER BY`, so "first" was whatever order Postgres
returned. Precedence was undefined.

On the demo host, the seeded fleet rule (all servers, any write tool, approver Ada, no approver role) shadowed the
specific rule for Dana · `repo-tools` · `write_file` (approver Avery plus an approver role). The quorum is already the
highest across every matched rule, so it stayed 2; the pool came from the fleet rule, which was Ada alone. Under
passkey signing that is `0 eligible approvers` besides the caller, and Dana's write was refused at queue time. The host
was worked around by giving the fleet rule the same approver role.

## Decision

1. **The most specific matching approval rule names the approver** (and the approver role). Specificity is compared
   lexicographically, most significant first:
   1. subject: a user rule (or a legacy rule with no scope) > a role or team rule (equal) > a fleet rule;
   2. tool: an exact tool name > any tool;
   3. server: one server > all servers;
   4. write-only: narrowed to write tools > every tool kind;
   5. deploy mode: bound to one mode > every mode;
   6. rule id, ascending, as a total-order tie-break.

   This is `compareApprovalRulePrecedence` in `packages/policy-kernel`. `matchingApprovalRules` returns every match
   sorted by it, so the kernel's decision, the gateway's queue, the access preview (`POST /v1/evaluate`, the
   Simulation page) and `demo:check` row E all read one answer.
2. **Precedence chooses who approves, never whether or how strictly.** Any matching rule still pauses the call. The
   gateway still takes the highest quorum across every matched rule (ADR-0186 A) and the strictest `approvalScope`
   (ADR-0104). A broad rule cannot be escaped by adding a narrow one: the narrow one only names who signs, under the
   strictest requirement of all the rules that matched. This is the "strictest combination" for the requirement and
   "most specific wins" for the routing.
3. **Defence in depth:** the gateway's approval-rule load is ordered by id, so the list every other reader sees (the
   approval context digest, logs) is deterministic too. The kernel does not rely on it.
4. **No relaxation.** No default changes; nothing is grandfathered. The demo host's workaround (the fleet rule given
   the same approver role) is harmless and may stay or go.

## Why most-specific-wins, and not a union of approvers

A union of every matched rule's approvers would widen the pool: a fleet rule naming one admin would let that admin sign
for a call the specific rule reserved for a named owner and their role. That is less secure, not more. Taking the
strictest quorum across all matches while letting the most specific rule name the pool keeps both the owner's intent
(who should sign this call) and the org's floor (how many must).

## Alternatives considered

- **First match in a stored priority column.** Needs a migration, an admin UI and an ordering every admin must keep
  right. Specificity is derivable from the rule itself and is what admins already expect from scoped rules.
- **The broadest rule wins.** It would make every specific rule dead whenever a fleet rule exists, which is the bug.
- **Open source.** Precedence over our own rule shapes is policy semantics, which CLAUDE.md reserves for RegulAIt's own
  code. Cedar (already used for ADR-0188 agent policies) has no "most specific wins" combining; its forbid/permit model
  does not name an approver.

## Consequences

- Tests: `packages/policy-kernel/src/index.test.ts` (fleet + specific in both insertion orders give the same decision;
  each dimension's order), `apps/gateway/src/zz-sim-parity-approval-queue.test.ts` case (d) (the preview and the queue
  agree on the specific approver in both insertion orders, and fail without the kernel sort),
  `apps/gateway/src/demo-relax-e-lib.test.ts` (row E checks the routing, not only the org settings).
- `demo:check` row E now reads the rules, users and servers and FAILs when the most specific matching rule for Dana's
  `write_file` names anyone but Avery. Before, it claimed the queue went to Avery from the org settings alone.
