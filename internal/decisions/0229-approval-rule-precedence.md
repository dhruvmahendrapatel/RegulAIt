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

## Amendment (2026-11-02, review of #662): outranking an overlapping rule is a pool change

**The finding (REQUEST CHANGES at `84e73b7`).** The approver pool comes only from the naming rule
(`toolApprovalRequirements`: its approver and approver role). Under decision 1 the naming rule is the most specific
match. So **creating** a narrower rule that overlaps a broader one, with a different pool, reliably hands the broader
rule's calls to the new pool. Editing the broader rule's own pool the same way is a `pool` loosening (ADR-0186 decision
28) and needs the `settings_relax` step-up; the create path had no such guard. The same happens on an equal-specificity
tie, where the arbitrary rule id decides. Decision 2's line "a broad rule cannot be escaped by adding a narrow one" held
for quorum and approval scope, but not for who signs.

**Options offered:** (a) treat a write that outranks an overlapping rule with a different pool as a pool loosening of
that rule (`approvalRuleLoosens`, then `requireRuleStepUp`); (b) require approvals to satisfy every matched rule's pool
(an intersection).

**Decision: (a).**

5. **A write that makes an approval rule take over a narrower pool needs the `settings_relax` step-up.** "Takes over"
   means: the rule as written may overlap the other rule (`approvalRulesMayOverlap`, conservative: only different users,
   different one-server ids, different exact tools or different deploy modes are disjoint; role and team rules may
   overlap anything, because membership is not known statically and changes), it is at least as specific
   (`compareApprovalRuleSpecificity` ≤ 0; **a tie counts**, since the id that would break it is arbitrary), and its pool
   loosens the other's (`approvalRuleLoosens`, the comparator an edit of that rule's own pool already uses; quorum is
   left out because the highest quorum across all matches applies anyway). Covered writes:
   - **create** (`POST /v1/rules/approvals` and the copilot's `rule_to_approval` applier, through `createApprovalRuleRow`);
     the step-up is bound to `{ruleId: "new-approval-rule", values: {outranksApprovalRules, approverUserId,
     approverRoleId}}`. The copilot applier has no request to step up, so it is refused while the policy asks for one
     (fail closed);
   - **edit and version activation** (rollback and canary promotion included), through `assertRuleLooseningStepUp`.
     Only a **new** takeover is owed: an edit that leaves routing and pool as they were owes nothing. A takeover rides
     the same single step-up as any other loosening in the same write, bound to the merged values.
6. **The execution recheck takes the highest quorum over every rule matching the call now** (`requiredQuorumNow` via
   `approvalRuleQuorumsMatchingNow`), not only the naming rule's. The queue already snapshots that maximum; since the
   naming rule is now the most specific and often not the strictest, a raise on a broader rule after queue time must
   also retire the old consents (ADR-0186 A). In practice the approval context digest already retires them
   (`approval_context_stale`); this is the second line.

**Why not (b).** An intersection needs every matched rule's pool snapshotted on the approval row (today one named
approver and one role), so a migration, plus a new eligibility model in the decide path and the recheck. That is a
larger change to a security path the day before a demo. (a) reuses the existing comparator and step-up, and an admin
can still create the narrower rule deliberately, audited, with the step-up. (b) stays open as a stricter option if an
owner wants "every rule's pool must sign".

**Tests.** `zz-b4-approval-rule-loosen-step-up.test.ts` (a fleet rule with a restricted pool, then a narrower rule with
a different pool: refused without the step-up and bound to the fleet rule, admitted with it; a narrower rule inside the
fleet pool, or a role rule with the same pool, needs none; a tie needs it; an edit that moves the approver carries the
takeover in its one step-up), `zz-b4c4-review-fixes.test.ts` (`requiredQuorumNow` reads a raised quorum on a broader
matching rule), and kernel tests for `compareApprovalRuleSpecificity` and `approvalRulesMayOverlap`.
