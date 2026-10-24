# ADR-0114 — A re-scan that still sees the SAME signature RE-OPENS a finding whose status claims the problem is resolved; and the rule it replaces was never ADR-0017's

- **Status**: Accepted
- **Date**: 2026-09-19
- **Relates to**: [ADR-0110](0110-rescan-reopens-a-miss-and-the-preflight-runs.md) (which made the
  backup LEDGER row re-open, left the FINDING alone, and named the gap this ADR closes as "a
  genuine honesty gap … owed its own decision"), [ADR-0017](0017-infra-ops-automation-ledgers.md)
  (the ledgers, the one approvals queue — and the ADR this rule was wrongly attributed to),
  [ADR-0109](0109-deferred-unique-constraints.md) (the refusal ADR-0110 answered; and the
  precedent that "the current behaviour is right" is a legitimate outcome)
- **Migration**: **none.** The `infra_findings.status` enum already carries `open`; this ADR
  changes which path writes it, not what may be written. `drizzle-kit generate` was **not** run,
  and nothing in `packages/db` changed.

## Context

### The mis-attribution, corrected first, because everything else depends on where the rule lives

ADR-0110's Honest limits said this:

> A re-scan does not re-open the FINDING, only the ledger row. … That is **pre-existing ADR-0017
> behaviour** ("a re-scan never resets a finding's status") …

**That attribution is wrong, and it was checked rather than assumed.** ADR-0017 contains no such
sentence and no such rule. The only idempotency claim it makes is about the *ledger*:

> **Neutral:** ledger idempotency leans on the scan's finding upsert plus a per-kind natural key,
> so **a re-scan never duplicates a ledger row**.

A duplicate-row claim is not a status claim. The rule ADR-0110 was describing lived in exactly one
place — an **inline comment in `apps/gateway/src/infra.ts`**, on the re-scan branch of
`scanResource` (line 883 on the commit this work started from, `48de1f0`):

> *"idempotent re-scan: refresh detected_at + the report payload; status is NEVER reset (a
> remediated/approved finding stays that way) and no new remediation is triggered."*

This is worth a paragraph rather than a footnote. A product rule attributed to an ADR reads as
*decided*; the same rule living only in a code comment reads as *how it happens to work*. The
mis-attribution made a comment look like a ruling, which is precisely the reason nobody had
revisited it. The rule that governed this behaviour was never argued anywhere. This ADR argues it,
and replaces it.

### What the rule costs, on the surface an operator trusts most

ADR-0110 made the `backup_runs` **ledger** row re-open when a re-scan still observes the backup
missing: "if a re-scan still observes the backup missing, the system says so. It does not keep
quiet because somebody once proposed a fix."

The **finding** did not follow. After a governed restore that reported success, the finding sits at
`remediated` for ever, whatever the scanner goes on seeing. So a restore can report success while
the gap is still live, and the product shows an operator a **closed finding over a live gap** — on
`GET /v1/infra/findings` and `GET /v1/infra/posture`, which are the compliance-inbox surfaces, the
ones an operator reads to decide whether anything is wrong. The ledger, which does now tell the
truth, is the surface they reach for *second*.

For a governance product, that is the failure mode ADR-0110 already refused in its own rejected
alternative: "hiding a live gap is worse than losing a cheap piece of workflow state."

### The precedent that makes this an inconsistency, not a trade-off

This is not a new principle. `infra.ts` line 670 already re-opens a finding when a certificate
rotation **fails** at the provider:

> *"re-proposable: the finding goes back to open, **never silently closed**."*

So "never silently closed" is this product's stated principle, written in this file, about this
table. The distinction as it stood:

| case | before this ADR |
| --- | --- |
| remediation **fails** at the provider | finding re-opens, audited, re-proposable |
| remediation **reported success**, and the next scan still sees the SAME signature | finding stays `remediated`, silently |

The second is not a scanner overruling a human. A re-scan seeing the **same signature** on a
resource whose remediation claimed success is *evidence the decision did not take effect*. Treating
the loud failure as re-openable and the silent one as final is backwards: the silent one is the
one an operator cannot otherwise discover.

## Decision

**A re-scan that observes the SAME signature on a finding whose status says the problem is
resolved RE-OPENS it to `open`, and writes an audited fact naming the contradiction.**

### 1. Bound to the SAME signature, which is what makes this evidence

The existing match is unchanged — `(resource_id, kind, detail->>'signature')`, the natural key
`infra_findings_natural_key_uq` is built on. The re-open rides that match and adds nothing to it.

This is load-bearing. Re-opening on *any* report for the resource would mean "the scanner disagreed
about something". Re-opening only when the **exact signature that was closed is observed again**
means "the gap demonstrably persists". A different signature on the same resource and kind is a
different problem and still creates its own finding, exactly as before — asserted, and shown to
bite in Non-vacuity probe C.

### 2. Which statuses re-open, and which do not — each argued, none by omission

The enum is `open | remediation_proposed | auto_remediated | approved | remediated | accepted_risk`.

| status | re-opens? | why |
| --- | --- | --- |
| `remediated` | **YES** | a governed remediation reported success and the same gap is still observable. This is the contradiction the rule exists for |
| `auto_remediated` | **YES** | the same claim, made by automation rather than a human. If anything the case is stronger: **nobody looked.** An automated remediation that silently does not work is exactly what an operator cannot discover by themselves |
| `accepted_risk` | **NO** | a human decided to **live with** a known problem. The scanner still seeing it is the **expected** outcome, not news. Re-opening it would nag an operator for doing precisely the thing the product asked of them, and would make `accepted_risk` unreachable in practice — a status that silently reverts on the next scan is not a decision, it is a delay |
| `remediation_proposed` | **NO** | it claims the problem is **being worked**, not that it is resolved — so there is no contradiction to report. The finding surface already shows the gap as unresolved, which is the honesty this ADR is about. Re-opening would destroy an operator's in-flight proposal and buy nothing. **This is where this ADR parts from ADR-0110 §2, deliberately**: on the LEDGER, `restore_proposed` was the state that stopped the row saying the gap was live, so superseding it bought real honesty at a real cost. Here it would pay the cost and buy nothing |
| `open` | **no-op** | already open. **And no contradiction row**: there is no closed claim to contradict. Writing one on every scan of every open finding would turn the audit log into a second copy of the scan log — and it is also the flapping bound (§5) |
| `approved` | **NO** | and it is **unreachable**. The enum carries it; **no write path in this repo sets it** (§3 enumerates every writer, and a test measures the claim). Were it reachable it would mean a decision taken whose outcome is not yet written — in flight, like `remediation_proposed`. Refused **defensively** rather than assumed away, the same posture ADR-0110 took with `success`/`failed` |

The re-open does **not** re-run the provider and does **not** re-trigger auto-remediation.
Auto-remediation fires on NEW findings only, unchanged; a re-opened finding is re-proposable by an
operator, which is exactly what `infra.ts:670` already does after a failed rotation. The two paths
now agree in behaviour as well as in principle.

### 3. Every writer of `infra_findings.status`, enumerated (M-035)

M-035 was earned when a guard watched one of several producers and passed while another was broken.
"The `accepted_risk` finding's status is unchanged" is exactly that shape of claim, so the
producers were enumerated before it was asserted. In `apps/gateway/src/infra.ts` (post-change line
numbers; nothing outside this file writes the column, repo-wide):

| line | writes | path |
| ---: | --- | --- |
| 468 | `remediated` | remediation approved (`applyInfraApprovalDecision`) |
| 481 | `accepted_risk` | remediation denied |
| **670** | **`open`** | **cert rotation FAILED at the provider — the precedent §Context cites** |
| 745 | `remediated` | operator-verb action approved (`cert_rotate`/`patch_apply`/`backup_restore`) |
| 805 | `accepted_risk` | operator-verb action denied |
| 948–958 | **`open`, when contradicted** | **the re-scan branch — this ADR** |
| 1002 | `open` (INSERT) | a NEW finding |
| 1031 | `auto_remediated` | auto-remediation of a NEW finding, within the scan |
| 1090 | `remediation_proposed` | `proposeInfraAction`, and only from `open` |
| 1427 | `remediation_proposed` | `POST /v1/infra/findings/:id/remediate` |

Three of these are reachable **during a scan** — the INSERT, the auto-remediate, and the re-scan
branch — and those are the three the "unchanged" assertions have to survive. Probe B (§Non-vacuity)
confirms the guard watches the branch that can actually break it: making the re-open over-eager
reddens the `accepted_risk` case.

### 4. The contradiction is an AUDITED fact, never a silent one

ADR-0110 §3's rule, reused rather than reinvented, in the same shape and the same vocabulary as the
audit rows `infra.ts` already writes (`objectType: 'infra_operation'`, `phase: 'scan'`, a `ruleId`
naming the event, a prose `reason`):

- **`ruleId: "infra-finding-reopened"`** — sibling to `infra-scan`, `infra-auto-remediate`,
  `infra-remediated`, `infra-action-applied`, `infra-action-denied`,
  `infra-cert-rotation-failed`, `infra-restore-proposal-superseded`.
- **`objectId`** is the finding, so the contradiction sits in the same audit stream as the
  remediation that closed it — one `objectId`, the whole story.
- **`effect: "allow"`**, matching `infra-scan`: this is an observation the scan is entitled to make,
  not a refusal.
- **`detail`** carries what was **claimed** (`priorStatus`), what was **observed** (`signature`,
  plus `resource`, `kind`, `severity`), what it became (`reopenedStatus: 'open'`), and
  **`priorDetectedAt`** — the finding's `detected_at` as it stood before this scan.
- **`reason`** says it in prose, including the signature and the prior status, so an operator
  reading the audit log alone can see why a finding they closed came back.

**On `priorDetectedAt`, honestly.** The question an operator asks is *when was this remediated?* and
`infra_findings` has **no `remediated_at` column**; this ADR adds no migration to invent one.
`priorDetectedAt` is the closest durable answer the schema already holds, and it is exact in the
reachable cases rather than approximately right: the re-open fires on the **first** scan after the
false close (§5), so the timestamp it carries is the last observation **before** the status closed
the finding. The moment of the remediation itself is already in the audit log under the **same
`objectId`** — `infra-remediated`, `infra-action-applied` or `infra-auto-remediate` — so the
contradiction row points at it rather than copying it.

### 5. The flapping risk, stated and bounded — with a mechanism this codebase already has

**The risk is real.** If a scanner lags a genuine remediation — the provider really did fix it, but
the next scan's view is stale — a finding re-opens immediately after being closed correctly, and an
operator is sent back to a problem that no longer exists. Signature-matching narrows this (the same
problem must still be **observable**, not merely something) but does **not** eliminate it: a stale
observation of the right signature is indistinguishable from a live one.

Two bounds, both already present. **No debounce mechanism was invented; this codebase has no
precedent for one, and inventing one to make a risk read smaller would be worse than stating it.**

1. **It fires at most ONCE per false close.** `open` does not re-open (§2), so the contradiction is
   reported on the first scan after the close and on no scan after that. There is no oscillation
   between `remediated` and `open` and no audit-row storm — a re-opened finding simply stays open
   until someone acts on it. This is asserted, not argued: *"the re-open fires ONCE per false
   close"*.
2. **The scan cadence is operator-driven, and that was verified rather than assumed.**
   `scanResource` has exactly **one** caller repo-wide — the `POST /v1/infra/scan` route. There is
   **no findings-scan scheduler**: the only infra timer in this codebase is ADR-0027's
   `backupVerifyTick`, which writes `backup_runs` rows and never touches `infra_findings`. So a
   re-open cannot fire between a remediation and its next *human-initiated* scan, which is the
   window a lagging scanner would need.

**What bound 2 does not do, said plainly**: it is a property of the deployment as it stands today,
not a guarantee. The moment someone schedules fleet scans — which pillar 3 will eventually want —
the window narrows to the scan interval and the flapping risk grows in exactly that proportion.
Whoever adds that scheduler owns this question, and this paragraph is the notice.

### 6. The ledger is not touched

ADR-0110's ledger paths are unchanged: `syncFindingLedger` still leaves a `restored` backup row
`restored`, a `rotated` cert `rotated`, a `patched` record `patched`. The two surfaces then say
different things about the same resource, and **both are true**: the ledger records that a restore
really did execute (history), the finding records that the gap is open (the alert). That split is
ADR-0017's own design — "findings stay the single inert alert surface; the ledgers carry state and
history" — and this ADR relies on it rather than blurring it.

## The rejected alternative

**Log the contradiction but leave the status closed** — write the `infra-finding-reopened` audit row
and nothing else.

Its honest merit: it never touches an operator's decision, so it cannot flap and cannot lose work.
It also makes the contradiction *discoverable*, which is most of the value.

Rejected because discoverable-in-the-audit-log is not the same as visible. The audit log is where
you go once you already suspect something; `GET /v1/infra/findings` is where you go to find out
whether to suspect anything. A product that knows a gap is live and reports it only to the surface
nobody reads unprompted has chosen the appearance of honesty over honesty. And it would have put
this file in the strange position of re-opening loudly when a rotation *fails* (`infra.ts:670`) and
merely whispering when a remediation silently does not work.

## What this deliberately does NOT do

- **It does not touch the ledger paths ADR-0110 built.** Not one line of `syncFindingLedger`'s
  backup, cert or patch branch changed. This is the finding half only (§6).
- **It does not add a migration.** The enum already holds `open`; no column, no index, no journal
  entry. **`drizzle-kit generate` was not run.**
- **It does not re-open `accepted_risk`, and that is the single most important refusal here.**
  Re-opening it would punish the operator for using the product as designed (§2).
- **It does not re-open `remediation_proposed`**, and therefore does not part from ADR-0110 by
  accident — §2 argues the difference between a ledger row and a finding explicitly.
- **It does not re-run the provider or re-trigger auto-remediation.** A re-opened finding is
  re-proposable by a human, exactly like the one `infra.ts:670` re-opens.
- **It does not invent a debounce, a cool-off or a re-open budget.** §5 states the residual risk
  instead. Adding a mechanism with no precedent in this codebase to make a disclosed risk read
  smaller would be the worse trade.
- **It does not add a `remediated_at` column** to answer "when was this closed?" more precisely.
  §4 uses what the schema already holds and points at the audit row that already has the answer.
- **It does not change `GET /v1/infra/posture`'s arithmetic.** `posture` counts `open` and
  `remediation_proposed` as open, so a re-opened finding starts being counted as open — which is
  the intended consequence, not a separate change.
- **It does not overturn ADR-0110.** ADR-0110 named this gap and said it was owed its own decision.
  This is that decision, and it corrects ADR-0110's attribution of the rule without disturbing any
  of its rulings.

## Honest limits

- **The flapping risk is not eliminated, only bounded** (§5), and bound 2 is a property of today's
  deployment that a future scan scheduler will weaken. Said again here because it is the cost of
  this decision, not a detail.
- **`priorDetectedAt` is not a remediation timestamp.** It is the last observation before the close,
  which is the closest the schema honestly gets without a migration (§4). An operator who wants the
  exact moment reads the `infra-remediated` / `infra-action-applied` / `infra-auto-remediate` row on
  the same `objectId`.
- **"The same signature" is only as good as the provider's signature.** A provider that emits an
  unstable signature (one carrying a timestamp, a counter or a host) would never match at all, and
  would create new findings instead of re-opening — a pre-existing property of the natural key, not
  introduced here, but this ADR now leans on it harder than anything did before. The mock provider's
  signatures are stable and derived from the resource name; the AWS/Azure/GCP adapters are not
  exercised here.
- **The provider under test is `MockInfraProvider`.** The lifecycle is ours and is driven end to
  end through the real HTTP surface, a real gateway and a real database — but the **observation**
  that feeds it is mocked, and a mock provider that "remediates" without changing what it reports is
  precisely the false-success scenario this ADR is about. That makes it the right fixture and a
  narrow one at the same time. No cloud API was called.
- **`approved` being unwritten is a claim about the paths that exist today** (§2, §3). Nothing in
  the schema stops a future writer from setting it, and the re-open would then silently not apply to
  it. The refusal is in code, not in the schema — the same limit ADR-0110 recorded about `restored`.
- **One existing test's fixture was invalidated by design and is updated, not deleted.**
  `infra.test.ts`'s *"refuses to propose a non-open finding"* reached for the `auto_remediated`
  runtime finding, which this ADR re-opens on the second scan in that same file. It now uses the
  `accepted_risk` finding the preceding case produces — a status this ADR deliberately does **not**
  re-open — so the claim under test (a non-open finding cannot be proposed, 409 `not_open`) is
  unchanged and is now asserted on a fixture whose state the ADR guarantees. Its sibling
  idempotency case gained the re-open assertion rather than losing anything.

## Non-vacuity (M-002 / M-033 / M-035, measured)

**The trap, stated first.** Three of this ADR's four required claims are **negatives** — *it did
NOT re-open*, *no audit row was written*, *the row is unchanged* — which is the shape M-033 warns
passes on wrong data, on a missing row, and on an empty query. So every negative is paired with a
**positive on the same row**:

- the `accepted_risk` case asserts the status is still `accepted_risk` **and** that `refreshed === 1`
  **and** that `detected_at` really did advance — so the scan demonstrably matched and wrote that
  row, and "status unchanged" constrains a row the scan touched rather than one it missed;
- the no-longer-observed case asserts `reopened === 0` **and** `created === 1` — the scan did real
  work, so the zero is not the zero of a scan that did nothing;
- the different-signature case asserts **two** rows exist afterwards (the decoy *and* a new
  finding), the new one carrying the signature the scanner actually emits;
- the `remediated` case asserts the close really happened (`status === 'remediated'`, zero audit
  rows at that point) **before** asserting the re-open, and finishes by re-proposing the re-opened
  finding for a **202** — a re-open that did not restore proposability would be cosmetic.

Counts are **deltas on scoped queries** (audit rows filtered to one `objectId`; findings filtered to
one resource), never table-wide totals, and every fixture carries a per-run token because the suite
shares one database.

**Three probes, because there are three separable claims: the re-open FIRES, it is CORRECTLY
BOUNDED BY STATUS, and it is BOUND TO THE SIGNATURE.** Run over
`infra-finding-reopen.test.ts` + `infra.test.ts` (13 cases) on a freshly created database:

| probe | result |
| --- | --- |
| as shipped | **13 passed / 13**, exit 0 |
| **A** — the re-open neutralised (`reopens = false`) | **3 failed / 13**, exit 1 — the `remediated` case (*expected +0 to be 1*), the fires-once case, and `infra.test.ts`'s idempotency case (*expected 0 to be greater than or equal to 1*). **The `accepted_risk` case, the no-longer-observed case and the different-signature case correctly STAY GREEN** — they constrain the fix rather than depend on it, which is the whole point of them |
| **B** — the re-open made OVER-EAGER (`reopens = true`, every status) | **2 failed / 13**, exit 1 — the **`accepted_risk`** case (*expected 1 to be +0*) and the fires-once case. So both of those negatives genuinely bite; neither is satisfied by an absent row. `infra.test.ts` stays green, correctly: its assertions are about `auto_remediated`, which re-opens under both |
| **C** — the signature predicate dropped from the match | **2 failed / 13**, exit 1 — the **no-longer-observed** case (*expected 1 to be +0*) and the **different-signature** case (*expected +0 to be 1*). Exactly the pair that stays green under A and B |

Every one of the four required cases reddens under at least one probe, and the two that are
*supposed* to stay green under A do so for the stated reason. No case is green under all three.

**M-035, applied rather than cited.** Before asserting "the `accepted_risk` row's status is
unchanged", every path that can write `infra_findings.status` was enumerated (§3 — ten writers, all
in one file, three reachable during a scan). Probe B is the check that the guard watches the right
one: it breaks the producer that is actually in that window and the guard reddens. A guard that had
watched, say, only the auto-remediate path would have stayed green through B.

**`approved` measured, not asserted in prose.** §2 refuses `approved` on the grounds that nothing
writes it. That is checked by a case that counts `approved` findings in the database (**0**) and
then inserts one directly to prove the **enum would accept it** — so the zero is the zero of an
unwritten value, not of an impossible one.

**Suite**: **179 files / 2740 passed / 9 skipped / 0 failed, exit 0**, on a freshly created
database. Against the baseline of 178 / 2734 / 9 / exit 0 that is exactly **+1 file and +6 tests** —
this ADR's own file — with **no other count moved**. `infra.test.ts`'s two updated cases changed
what they assert, not how many they are. Repo-wide `pnpm -r build` then
`pnpm -r exec tsc --noEmit`: clean, exit 0 on both.
