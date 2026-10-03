# ADR-0105 — A consent is bound to the policy that demanded it, and it does not live forever

- **Status**: Partially superseded by ADR-0130 (2026-09-30)
- **Date**: 2026-09-07
- **Relates to**: [ADR-0104](0104-approval-payload-binding.md) (the payload half of the same
  fingerprint — this ADR is its second half and reuses its machinery rather than replacing it),
  [ADR-0073](0073-rules-engine-versioning.md) (every approval rule already resolves through
  `config_versions`; the ACTIVE version id it resolves to is the hook this ADR binds to, so no
  parallel versioning concept is invented), [ADR-0060](0060-tamper-evident-audit.md)
  (`canonicalJson` + `sha256Hex` — the one canonicalization, called again),
  [ADR-0098](0098-api-key-expiry.md) (the stamp-at-issuance discipline the expiry copies, and the
  dial-shape this one deliberately departs from), [ADR-0040](0040-abac-policy-as-code.md) (the ABAC
  route into the same queue, which is why the required approver is asked of the kernel rather than
  re-derived), [ADR-0046](0046-review-workbench.md) (the one queue and the `superseded` status
  this reuses), [ADR-0070](0070-trace-observability.md) (a refusal is a `denied` span carrying its reason),
  [ADR-0103](0103-mcp-path-project-budget-gate.md) (the outcome-variant pattern the two new
  variants follow)
- **Migration**: `0107_consent_context_and_expiry` — `approvals.context_digest`,
  `approvals.expires_at`, `org_settings.approval_ttl_hours`.

## Context

ADR-0104 fixed a consent that said nothing about **what** it was consent for. It did not touch a
second, independent question: consent **under what policy**, and consent **for how long**.

Both gaps were verified against the tree this ADR is written from:

| where | what it did |
| --- | --- |
| `packages/shared/src/approval-binding.ts` — `approvalArgumentsDigest` | fingerprinted `{projectId, arguments}` and nothing else |
| `packages/db/src/schema.ts` — the `approvals` table | stored `ruleId`, `approverUserId`, `requestedAt`, `decidedAt`, `argumentsDigest`; **no expiry, and no rule/config-version identity** |
| `apps/gateway/src/mcp-proxy.ts` — the consumption | `UPDATE approvals SET status='consumed' WHERE id = ? AND status = 'approved'`. **No digest recheck, no freshness check, no expiry check.** |
| `apps/gateway/src/app.ts` — the decide route | checked the `approverUserId` **stored on the row** (plus delegation / admin override) and never re-derived who is *currently* required |

So:

**(a) Stale policy, stale approver.** A consent queued and approved under rule/config A stayed
spendable after a stricter rule version B activated, or after the rule was edited to name a
different required approver — provided user, server, tool, project and arguments were unchanged.
The authorization check ran against yesterday's policy; the use happened under today's. That is a
time-of-check/time-of-use gap in the authorization itself, not in the payload.

**(b) No expiry.** An approved-but-unconsumed row was spendable indefinitely. An approval is a
human decision about **one pending action**. A signature that is still live a month after the
situation it was given in is not the decision that human made.

### What was already true, and is not being re-litigated

- **The payload binding of ADR-0104 stands unchanged.** Everything below is *additional* — a second
  test on top of the first, never a replacement for it.
- **Consumption is atomic and single-use.** The `status = 'approved'` conjunct is untouched and
  re-pinned. It bounded the exposure to one stale spend per approval cycle; it was never the fix.
- **Rules already resolve through `config_versions` (ADR-0073).** `loadVersionsForArtifacts` /
  `applyRuleVersions` already know, at evaluation time, which stored version is ACTIVE for each
  rule. That is a resolvable version identity per rule, and inventing a second one beside it would
  have been the bug this codebase keeps refusing to write. `applyRuleVersions` now *surfaces* the
  answer it already computed instead of a caller re-deriving it.

## Decision

**A consent is bound to the POLICY CONTEXT it was granted under as well as to its payload, and it
carries an expiry stamped at queue time. Both are re-derived at consumption and asserted inside the
one atomic statement that spends the row.**

### 1. A second digest, deliberately not a bigger first one

`approvals.context_digest` is a **separate** sha256 from `arguments_digest`, with its own version
tag (`regulait.approval-context.v1`). Two reasons, both load-bearing:

- **They fail independently, and the reason is recoverable.** "The payload changed" and "the policy
  changed" are different facts about a refusal, and an approver and an auditor need to be able to
  tell them apart. One combined hash collapses both into a single opaque mismatch.
- **They have different natures.** The payload digest is a fact about the CALL and never moves for
  a given call. The context digest is a fact about the GOVERNING POLICY and moves underneath a
  stationary call. Folding them together would make the payload digest look mutable.

**What is in it** — and this list *is* the compatibility rule (§5):

- the **matched** approval rule ids — the set `matchingApprovalRules` already returns, the kernel's
  own predicate rather than a second copy — each paired with the **id of the `config_versions` row
  currently ACTIVE for it**. `null` when a rule has no version rows at all, which is the
  byte-identical pre-ADR-0073 case and must hash to a **stable** value: if "unversioned" hashed to
  anything variable, every unversioned rule would look like a policy change on every call.
- the **required approver** for this call as policy currently reads it.
- the **approval scope** (`action` | `tool`), because flipping it changes what a signature *means*.

The pairs are **sorted before hashing** (by rule id, then version id). The rule loads carry no
`ORDER BY` and are owed none — the kernel's decision does not depend on row order — so a digest
that *did* depend on it would be a consent that spontaneously stops matching when the planner
changes its mind, which reads exactly like a policy change and is not one. That is pinned by a
test.

The serialization is ADR-0060's `canonicalJson` + `sha256Hex`, **called**, exactly as
`approvalArgumentsDigest` calls them. There is one canonicalizer in this repo.

### 2. Computed once, in `governedEvaluate`

Both digests are computed in the same place, in the same function, and returned together. The queue
writer, the audit writer and the consumption predicate all use those exact strings. A second
derivation site could disagree with the first, and a consent-identity feature whose two halves can
disagree is the defect wearing a fix's clothes.

**How the required approver is obtained, and why it is not re-derived.** The digest needs "who does
policy require *now*", the row selection needs the digest, and the decision needs the selected row —
a three-way circularity. It is broken by evaluating the kernel **once holding no consent at all**.
That pass answers precisely the question the finding says nobody was asking: *if this call arrived
right now with nothing signed, who would have to sign it?* Asking the kernel is the only honest way
to get that answer — an `approval_rules` row is not the only thing that can demand an approver
(ADR-0040's Cedar layer can too), and re-implementing the kernel's selection order here would be
the second copy. `evaluate` is pure and zero-I/O, so the second pass costs nothing but a function
call, and it is only made when a consent is actually held.

### 3. Expiry

`approvals.expires_at` is stamped at **queue** time as `requested_at + org_settings.approval_ttl_hours`.

**The dial defaults to 72 hours, and that is a deliberate upgrade-day behaviour change.** It is
*not* ADR-0098's posture of shipping a lifetime dial off. ADR-0098 could ship `NULL` because a
never-expiring API key was the status quo it was giving operators a way to leave; here the
never-expiring approval **is the defect**, and shipping the dial off would have left gap (b) open
for exactly the population that already has it — the same argument ADR-0104 made for
`approval_scope NOT NULL DEFAULT 'action'`. Operators with signatures in flight at upgrade time
will see them lapse after three days rather than never.

**Setting the dial to `NULL` means "never expires". It is a supported operator choice, it is
recorded as one, and it knowingly reopens gap (b).** It is stated here rather than left to be
discovered because a dial that silently restores a closed vulnerability should be documented as
doing that.

Expiry is **stamped, never recomputed** — the ADR-0098 discipline. Lowering the dial cannot retire
consents that already exist; raising it cannot extend them. The value on the row is the promise
made when the approver was asked.

### 4. Re-derivation at consumption — the core of the fix

```sql
UPDATE approvals SET status = 'consumed'
 WHERE id = ?
   AND status = 'approved'
   AND arguments_digest = ?          -- action scope only; see below
   AND (context_digest = ? OR context_digest IS NULL)
   AND (expires_at IS NULL OR expires_at > now())
```

The whole test is **in the predicate, not around it**. Check-then-update leaves a window in which a
row can be checked good and spent bad; a single conditional statement does not. Two callers racing
for one consent still resolve to exactly one winner (the `status` conjunct, unchanged), and a
caller whose evaluation is already behind a policy activation cannot spend on the strength of it.

- `arguments_digest` is asserted **only under `action` scope**. Under ADR-0104's `tool` escape
  hatch a different payload's digest — or a legacy `NULL` — is exactly what the row is allowed to
  carry, so asserting it there would quietly delete the escape hatch.
- `expires_at` is compared against the **database's** `now()`, not this process's clock. The row is
  being changed there; the freshness question is answered there.

**On zero rows affected the reasons are distinguished, not collapsed.** The row is re-read and
classified: somebody else spent it (`approval_consumed_race`, unchanged), it lapsed
(`approval_expired`), or the policy moved underneath it (`approval_context_stale`).

### 5. Visible disposition

A stale or expired row is **superseded**, with an audited fact naming why, and a fresh approval
carrying the current digests is re-queued in its place. It is never silently skipped: left sitting
in the queue marked `approved`, a dead consent is a live-looking signature that every later
evaluation has to re-refuse and that an approver reading the workbench has no way to identify.

`approvals.status` **already carries `superseded`**, so no DDL was needed for it — the status means
exactly what it means everywhere else in the queue: this gate is dead, not decidable.

The retirement is sited in the `require_approval` branch, after the deny / compliance / budget
gates. A call refused for some *other* reason has said nothing about whether the stored consent is
still good, and retiring on the way past would be acting on a question nobody asked; a genuinely
stale row is retired the next time it is actually reached for.

### 6. The compatibility rule — stated plainly

**Invalidates a consent:**

1. a change to the **set of approval rules that match** the call;
2. a change to the **active `config_versions` version of any matched rule** (activation, rollback,
   or the first version ever minted for a previously unversioned rule);
3. a change to the **required approver**;
4. a change to the **approval scope**.

**Does not invalidate a consent:** everything else — because it is not in the digest. Editing or
versioning a rule that does not match this call, changing a rate limit, changing a data-scope rule,
changing an unrelated project's budget, an org-settings edit, the passage of time within the TTL.

That symmetry is the point. A rule that only ever says "no" is a reset, not a compatibility rule,
so the direction that must **not** invalidate is pinned by its own test.

### 7. Legacy rows — both columns, stated rather than implicit

- **`context_digest IS NULL` is ACCEPTED.** Such a row predates 0107 and is still **payload-bound**
  under ADR-0104 — and under the default action scope a legacy `arguments_digest IS NULL` row
  already fails to satisfy, so the surviving population is small, recent, and already fingerprinted.
  Rejecting it as well would re-queue consents for a property that did not exist when they were
  signed, on top of the re-queue 0106 already caused: two upgrade-day storms for one gap. The
  fail-closed alternative was considered and rejected on that ground, not on principle — it is the
  weaker of the two guarantees this ADR ships, and it heals on the next re-queue.
- **`expires_at IS NULL` does NOT expire.** There is no honest `requested_at`-relative TTL to
  impose retroactively on a row whose approver was never told one applied, and inventing one would
  retire signatures under a rule nobody agreed to.

### 8. Outcome variants

`approval_expired` and `approval_context_stale` join `GovernedToolCallOutcome`, following ADR-0103's
`budget_blocked` exactly. Both switches over the union are exhaustive with no `default`, so the
compiler forced both call sites — the MCP proxy route and pillar 7's worker loop — to say what they
do. Both close an ADR-0070 `denied` span carrying the reason; a refusal is never an absent span.
Each carries the superseded row ids and the replacement's id, so a caller learns *which* signature
is dead and *which* row now needs signing rather than retrying into the same wall.

## What this deliberately does NOT do

- **It does not invent a second versioning concept.** The version identity is ADR-0073's own
  resolved active `config_versions` id, surfaced from the resolver that already computed it.
- **It does not change the decide route.** The gap the finding names there — that deciding checks
  the approver stored on the row and never re-derives who is currently required — is closed at the
  *use* site instead: a signature from someone who is no longer the required approver produces a
  context digest that does not match, and the consent fails closed at consumption. Rewriting the
  decide path as well would have been a second enforcement point for one rule.
- **It does not expire the other object types.** `workflow`, `run`, `project`, `infra_operation`,
  `model_card`, `copilot_proposal`, `training_job`, `grant_certification` and `sod_override` rows
  ride the same one queue and are stamped with no expiry, so their behaviour is byte-identical.
  Only the MCP tool-call consent path — the one the finding is about — is changed. Extending the
  TTL to the other producers is a separate, larger decision about what a lapsed workflow gate means.
- **It does not add a per-rule TTL.** One org-level dial, as `budgetHardBlockPct` and
  `apiKeyDefaultTtlDays` are. A per-rule override is a second place the answer lives, for a control
  nobody has yet asked to vary.
- **It does not put arguments anywhere new.** Digests only on the audit row; ADR-0099's scrubbed
  preview on the queue row stays the single human-readable rendering of a payload.
- **It does not retire consents in the background.** There is no sweeper. A lapsed row is retired
  the moment a call reaches for it, which is the moment the fact matters.

## Honest limits

- **The TTL default is a real behaviour change on upgrade day.** Every existing `org_settings` row
  is backfilled to 72 hours by the column default, and every consent queued from then on lapses.
  This is chosen, not overlooked, and the escape is a documented dial — which reopens the gap.
- **`context_digest IS NULL` is accepted, and that is the weaker choice.** A legacy approved row
  queued before 0107 that still satisfies ADR-0104's payload test can still be spent under a policy
  that has since changed. The population is bounded (only `tool`-scoped rules and post-0106 rows
  survive ADR-0104's own legacy refusal) and it heals within one approval cycle, but it is not zero,
  and an operator who wants it zero today can bump `APPROVAL_CONTEXT_DIGEST_VERSION` — which makes
  every pre-existing consent re-queue.
- **The atomicity claim is bounded by where the digest is derived.** The predicate makes
  check-and-spend a single statement, so no consent can be checked good and spent bad, and two
  racers cannot both win. What it cannot do is freeze policy: a version activated *after* this
  call's rule snapshot was read but *before* its UPDATE lands leaves a window of one request in
  which the call is judged against the snapshot it read. Closing that would require locking
  `config_versions` for the duration of every tool call, which trades a one-request window for a
  global serialization point on the hot path. The next call is already bound to the new version.
- **The digest binds the rules that matched, not the entitlements behind them.** Revoking the
  caller's grant, changing a rate limit, or narrowing a data-scope rule does not invalidate a stored
  consent — but it does not need to, because those are re-evaluated on every call and deny
  independently of any approval. The digest is about *whose signature this is and under what*, not
  about whether the call is otherwise permitted.
- **ABAC-driven pauses inherit the same residue ADR-0104 named.** `abac_policies` has no scope
  dial and no rule id in the matched set, so a pure-ABAC `require_approval` contributes only the
  required approver and the (default `action`) scope to the context. Editing the Cedar policy that
  demanded the pause does not, by itself, invalidate the consent unless it changes who must sign.
  That is a genuine hole, narrower than the one closed, and it is out of scope here.
- **`superseded` is reused, not extended.** An approver reading the workbench sees the status and
  the recorded `decision_reason`; the machine-readable retirement reason lives on the audit row, not
  on the approvals row. Anyone building a UI that needs to distinguish "superseded because the run
  moved on" from "superseded because the consent lapsed" will need that column.
- **The audit row is not transactional with the call**, as elsewhere in this codebase.

## Non-vacuity (M-002, measured)

The new predicate was **neutralised in place**, with the columns, the stamping and both digest
computations left exactly where they are — only the *acting* on them stopped, so nothing became
unreachable:

- `governed-evaluate.ts`: the freshness filter replaced by `() => true`, so an expired or
  context-stale row is selected again;
- `mcp-proxy.ts`: the two new conjuncts removed from the consumption predicate.

The suite was re-run against a **freshly created database**.

**6 of the 11 gateway tests reddened**, and the negative control reddened in exactly the right way:
`expected 'allowed' to be 'approval_context_stale'` — under the neutralised predicate, a consent
signed under rule version A **executed** under version B. That is finding AER-004 (a), reproduced.
The expiry test reddened the same way: `expected 'allowed' to be 'approval_expired'` — gap (b),
reproduced.

**The 5 that correctly stayed GREEN are the point of the exercise**:

| test | why it must stay green |
| --- | --- |
| the 72-hour expiry stamp on a fresh row | asserts the queue-time *stamping*, which the probe left alone |
| the NULL dial stamps no expiry | same — an operator-choice assertion, not an enforcement one |
| an unrelated rule versioned → consent still spendable | asserts **unchanged** behaviour; a neutralised predicate must leave it passing, and a probe that reddened it would have meant the digest was over-broad |
| two concurrent calls → exactly one succeeds | asserts ADR-0104's pre-existing single-use atomicity, which this batch must not regress |
| concurrent consumption + concurrent activation → never two winners | asserts the same atomicity property; its stale-spending half is pinned deterministically by the reddening tests above, and this one is honestly the weaker assertion of the pair |

The probe was reverted exactly (`git checkout` of both files against the committed tree; `git
status` clean apart from the new test file).
