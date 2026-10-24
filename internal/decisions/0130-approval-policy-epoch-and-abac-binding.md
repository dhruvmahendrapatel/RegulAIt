# ADR-0130 - Approval policy epoch and ABAC consent binding

- Status: Accepted
- Date: 2026-09-30
- Supersedes: ADR-0105's legacy-null acceptance and snapshot/consume atomicity claim
- Finding: AER-004
- Migration: 0119

## Decision

An approved MCP consent must carry the current versioned context digest. A
legacy approval with `context_digest IS NULL` is superseded and re-queued; it
cannot authorize execution. The digest now includes the identity, version and
source of every active ABAC policy, as well as the matched approval rules and
approver already recorded by ADR-0105. The digest version is v2, so older
signatures are re-queued rather than interpreted under the new contract.

`governance_policy_epoch` orders evaluation against policy writes. Database
statement triggers advance the epoch for approval-rule, config-version and ABAC
policy/version writes, including direct SQL changes. Evaluation reads the
epoch before it reads the policies. Consent consumption takes a shared lock on
the epoch row inside the same transaction as the conditional approval update.
If the epoch changed, the consume fails and the caller must evaluate again.
Policy writes take an exclusive row lock through the trigger, so one side
commits before the other observes the epoch. Concurrent consumes hold shared
locks and still compete on the approval status predicate for one winner.

The operator may select a null approval TTL. Settings GET and PUT explicitly
name that state `nonexpiring_high_risk`, and settings audit records it. This
does not extend an existing approval's stamped deadline.

## Verification

Fresh-database tests must prove legacy-null re-queue, ABAC-only version
invalidation, and activation between evaluation and consumption leaving the
old consent unspent. Denied calls must have zero upstream contact. The existing
unrelated-rule compatibility and two-consumer race tests continue to run.

The epoch covers the policy tables listed above. It is not a general
transactional snapshot for every entitlement, budget, or emergency setting.
It proves freshness at approval consumption, before the upstream call begins;
a later independent policy write cannot undo an already-consumed approval.
