# ADR-0108 — The test-side sweep: multiplicity is measured, not inferred, and most of it is benign

- **Status**: Accepted
- **Date**: 2026-09-09
- **Relates to**: [ADR-0107](0107-unordered-single-row-reads.md) (this is the follow-up batch it
  explicitly owed — its production sweep fixed 19 and deferred 11, and left **103 at-risk test
  sites classified but unfixed**), [ADR-0105](0105-consent-context-binding-and-expiry.md) (§1's
  inverse rule: a read whose result must NOT depend on order is owed no `ORDER BY`),
  [ADR-0106](0106-mock-socket-net-contract.md) and [ADR-0073](0073-rules-engine-versioning.md)
- **Migration**: **none.** Deliberately — see "What this deliberately does NOT do".

## Context

ADR-0107 hunted one defect — *a query that does not ask for an order, whose caller then depends on
one* — through `apps/gateway/src` and `packages`, fixed 19 production sites, deferred 11 to unique
constraints, and stopped at the boundary it disclosed:

> **It does not fix the 103 at-risk test sites.** They are classified and reported, not edited.

This ADR is that follow-up. Its finding is not the one the setup implies.

**Production was NOT re-swept here, and is not re-litigated.** The coordinator re-scanned and
hand-checked the shapes 0107's regexes could not match: `audit-chain.ts` filters on `audit_log.seq`
(`audit_log_seq_uq`), `abac.ts` filters a primary key or a unique pair, and the `mcp-registry.ts`
sites are existence-only. This batch is test files only.

### The scan, and the bounds it was run under

Two populations were swept:

1. **ADR-0107's shape** — `const [x] = await db.select(...)` and `.limit(1)`, with no `.orderBy(`.
2. **The shape ADR-0107 never matched** — a select, or a local array-returning helper, assigned to
   a variable and then indexed positionally (`v[k]`, `v.at(k)`) later.

Population 2 is where a scan inflates, so its bounds are stated rather than left implicit:

- the positional index must appear **within 12 lines of the end of the assignment statement**, and
- the element must be **actually used** — a property read, or handed to an assertion. A bare
  `if (rows[0]) …` existence check does not count.

Both bounds matter. `rows`, `before`, `after` and `existing` are common enough names that an
unbounded backward search attributes an index to the wrong assignment several files away.

Carried over from ADR-0107: aggregate selects (`count`/`sum`/`avg`/`max`/`min`/`coalesce`) and
predicates pinned to a primary key (`eq(t.id, …)`) are excluded, as is anything already ordered.

**249 candidates**: A-destructure 155, `.limit(1)` 3, B-positional 50, B-helper 41. The two B
shapes — **91 sites** — are the population ADR-0107 could not see.

### Uniqueness was measured against the running database

All 107 migrations were applied to a fresh database and `pg_index` queried directly, exactly as
ADR-0107 did, because a partial index is misread in both directions by schema-reading. That
reproduced 0107's figures precisely: **290 unique indexes — 274 plain and 16 PARTIAL.**

51 candidates are provably covered (41 plain, 10 partial-covered). The trap shape recurs: the
`shadow_ai_findings` sites look covered by name, but `shadow_ai_findings_correlation_uq` is on
`(subject_kind, lower(subject), lower(provider))`, so a bare `eq(subject, X)` is **not** inside it
— the same mistake as 0107's `guardrail_configs_org_uq` bug.

### And then multiplicity was measured too — which is where the population collapses

208 candidates survive the index check. Rather than argue from the fixtures about how many rows
each predicate *could* match, **145 of the 148 hand-review candidates were instrumented in place**
— the array length logged at the read — and the **full suite run against a freshly created
database**, so every count below is the real one under the real condition: one shared Postgres
across all 174 files, not a file measured in isolation.

That measurement repeatedly overturned sites that looked real from the source alone:

| site | looked like | measured |
| --- | --- | --- |
| `regulait-llm.test.ts:494` (`llm-dataset-pii-blocked`) | a rule that fires repeatedly | **1 row** |
| `regulait-llm.test.ts:665` (`objectType='training_job' AND userId=rika`) | not even a rule id — any of rika's job audits | **1 row** |
| `infra-cert-lifecycle.test.ts:162` (`infra-cert-rotation-failed`) | a bare rule id, no object filter | **1 row** |
| `mcp-tool-pricing.test.ts:123` (`mcp-tool-price-set`) | a pricing suite that sets several prices | **1 row** |
| `a4-mode-dimension.test.ts:175`, `infra-backup-verify.test.ts:76` | bare rule ids | **1 row each** |

Every one of those would have been a plausible-looking fix that was pure noise.

## Decision

**A test site is changed only when the predicate really does match more than one row — measured,
not inferred — AND the assertion really does depend on which row came back. Everything else is
left exactly as written.**

### The second half of the discriminator is what does the work here

ADR-0107's production sweep was mostly gated on the *first* half (can the predicate match twice).
On the test side the first half is satisfied constantly and the *second* half is what clears the
population. Three benign patterns account for nearly all of it:

1. **The test pins its own cardinality** — 60 sites carry an explicit `expect(v).toHaveLength(1)`
   or `expect(v.length).toBe(1)` in the window. Order cannot matter to a one-element array.
2. **Singleton tables** — `org_settings` (9 sites) is a true singleton: production reads it as
   `eq(orgSettings.id, ORG_SETTINGS_ID)` and no other id is ever inserted. `data_key_state` (9
   sites) is the singleton-by-convention that ADR-0107 already **deferred to a check constraint**;
   ordering it here would encode the wrong claim, so it stays deferred.
3. **The assertion is true of ANY matching row** — the largest group by far, and the one that a
   count of syntactic candidates cannot see. Measured examples:

   | site | rows measured | why order still cannot matter |
   | --- | ---: | --- |
   | `onboarding.test.ts:617` | **7** | asserts `objectType === "onboarding_step"` and `effect === "allow"`; `onboarding.ts:380` is the single writer of that rule id and hardcodes both |
   | `interception-depth.test.ts:639` | **5** | asserts `objectType === "interception_scope_rule"` — invariant across every row that rule emits |
   | `onboarding.test.ts:325` | **2–4** | asserts `effect === "deny"` on a refusal-only rule id |
   | `scheduler.test.ts:401` | **2** | asserts `objectType`, `effect`, and that the row's `objectId` is *one of* that job's run ids — all three hold for either row |
   | `cost-import.test.ts:459` | **2** | picks a `planned` batch and asserts `DELETE` returns 409 `not_revocable`. Only an *applied* batch is revocable, so **every** planned row gives the same 409 — the one non-`audit_log` example, and the clearest: the test is asserting a property of the status, not of a row |

   Adding an `ORDER BY` to any of these is the noise ADR-0107 forbids: it tells the next reader that
   ordering mattered here, and it makes the real fix harder to see.

### The fix

| # | site | rows measured | why the row matters | fix |
| --- | --- | ---: | --- | --- |
| 1 | `data-key-reencrypt.test.ts:498` | **4** | this file runs four re-encryption walks, each writing one `data-key-reencryption-completed` row. Only the **last** one is `completed_with_failures` and names the corpse. The other three say plain `completed`, so `.at(-1)` landing on any of them fails all three assertions | **pinned, not ordered** — the predicate gains `detail->>'runId' = outcome.runId`, the same run id the test already used one line above to pin its `data_key_reencryption_runs` row |

Pinning was preferred over an `ORDER BY` because it is the stronger test: it asserts *the row this
walk wrote*, rather than *whichever row an order happens to put last*. The test already had the
identifier in hand.

## What this deliberately does NOT do

- **No migration, and no `drizzle-kit generate`.**
- **It does not touch production.** ADR-0107 finished that, and the survivors it could not match
  were re-checked independently before this batch began.
- **It does not touch a benign site**, and the measurement is what earns that word. 148 candidates
  reached hand review; one is changed. Adding order to the other 147 would be a large, plausible,
  entirely wrong diff.
- **It does not re-open ADR-0107's 11 deferred constraints.** `data_key_state`'s nine test sites sit
  squarely on one of them and are left for it.
- **It does not change what any test asserts.** No assertion was weakened, strengthened, or
  rewritten; the one changed site asserts exactly what it asserted before, about a row it can now
  name.

## Honest limits

- **This is a partial sweep, and the partition is stated rather than blurred.** 249 candidates
  found, 51 cleared by the index map, 60 by an explicit cardinality assertion, 145 measured under a
  full-suite run, **1 fixed**. The remaining sites are classified as benign *by a measured row count
  plus a hand-read assertion*, not merely by inspection — but they were classified in bulk by
  pattern, and a mis-read invariant somewhere in 147 sites is possible.
- **The measurement is of the suite as it runs today.** A count of 1 is a fact about the current
  fixture, not a guarantee. A future test that adds a second dataset, a second import or a second
  walk turns several of these single-row sites real on the day it lands. That is the honest reason
  ADR-0107 called them "at worst, future flakes", and it remains true of the 147 left alone.
- **Three of the 148 could not be instrumented mechanically** and were read by hand instead.
- **`.at(-1)` was swept; `sql.raw` and `Promise.all([...])` destructuring still are not.** ADR-0107
  listed four unswept shapes; this batch closes the first two (`.at(-1)`, `rows[0]`) and leaves the
  other two.
- **A non-total order was found, measured, and deliberately left alone** — see below. It is the
  single most likely thing in this ADR to become wrong later.

### The `desc(auditLog.at)` cluster: non-total, measured, and left

43 test sites consume a single row under an order that is **not total**; 27 are
`desc(auditLog.at)`, nearly all inside a `lastAudit(ruleId)` helper. By ADR-0107's "Total, not
merely deterministic" rule that looks like a whole unswept cluster, and `schema.ts` says so itself
of `audit_log.seq`:

> *strict total chain order. NOT `at` — timestamps collide and are not monotonic.*

So it was measured. Over **2,453 audit rows** left by a full-suite run there is exactly **one** group
sharing an identical `at` — two rows written inside one transaction:

```
seq 1221 | l6-seeded-deny  | mcp_tool | 2026-09-09 01:41:05.505+00
seq 1222 | l6-seeded-allow | mcp_tool | 2026-09-09 01:41:05.505+00
```

The tie is real, and it is **across two different rule ids**. Every one of the 27 sites filters on a
single `rule_id`, and there are **zero** groups sharing an identical `(rule_id, at)`. So none of them
is ambiguous today, and ordering them would add 27 sorts to answer a question nothing is asking.

They are left alone as a **measurement, not an oversight** — and with the tripwire named: the day
any writer emits two rows with the *same* rule id inside one transaction, this cluster becomes real,
and `desc(auditLog.at), desc(auditLog.seq)` is the ready-made total fix, because
`audit_log_seq_uq` makes `seq` unique.

### A correct pattern, found and deliberately not touched

`rule-write-versioning.test.ts:101`'s `versionsOf` helper is genuinely unordered — and correct,
because every caller pins by value rather than position (`rows.find(r => r.version === 1)`) or does
a set-difference on `id`, carrying the author's own comment:

> *set-difference on id — never a row picked by position out of an unordered query*

Its two same-named siblings (`config-versions.test.ts:167`, `agent-model-edit.test.ts:100`) **do**
order by `version` — which is total, since `config_versions_artifact_version_uq` is
`(artifact_type, artifact_id, version)` — because their callers index positionally. Three helpers,
two orderings, all three right. This is the shape the sweep is trying to preserve, not flatten.

## Non-vacuity (M-002, measured)

Each of the three fixes was neutralised in place and probed separately. The result is not a clean
sweep, and the ragged part is the informative part.

**The mechanism, verified independently first.** An unordered read passes today only because a
freshly written heap happens to return insertion order. ADR-0107's context names the real-world
cause: *"whether a row has been updated (and therefore rewritten at the end)"*. That was reproduced
directly before relying on it:

```
BEFORE-UPDATE physical order: 3,7,10,12
UPDATE heaporder SET reason = reason WHERE seq = 3;
AFTER-UPDATE  physical order: 7,10,12,3     -- an unordered seq scan now returns 3 LAST
```

So the probe is the strongest form ADR-0107 used, expressed for a table whose write order the test
does not control: rather than inserting rows in the opposite order, it makes the **oldest** row the
physically last one, which is exactly what `.at(-1)` then picks.

**RESULT — 1 of the 3 fixes reddens under probe, and the other 2 CANNOT, which is itself the
finding.**

| site | probe | outcome |
| --- | --- | --- |
| `data-key-reencrypt.test.ts:498` | fix reverted; the OLDEST `completed` row rewritten so the heap returns it last, which is what `.at(-1)` then picks | **RED** — `expect(last.reason).toContain("completed_with_failures")` failed at line 510. A real intermittent, really fixed. |
| `credentials-keys.test.ts:218` | fix reverted; confirmed the read returned **another user's** row (`nina? false`, 2 rows visible) | **STILL GREEN** — and that is the defect. The assertion is `not.toContain("sk-nina-own-key")`; a foreign row satisfies it *trivially*, without the test ever examining the row it claims to be about. |
| `mcp-tool-pricing.test.ts:123` | fix reverted; `mcp-project-budget.test.ts` drives the same PATCH first and its row carries an identical `{before: null, after: 0.05}` | **STILL GREEN** — passes on either row by coincidence of equal payloads, not by construction. |

**Two of these three tests were not flaky. They were VACUOUS**, and a vacuous test is worse than a
flaky one: a flaky test eventually tells you something is wrong, whereas these would have gone on
passing forever while examining the wrong row. `credentials-keys` is the sharper case — it exists to
prove one user's stored key never leaks into another's ciphertext, and it was capable of proving
that about a row belonging to nobody in particular.

**This is why "revert the fix and watch it redden" is a necessary but not sufficient bar.** It
tests whether the FIX is load-bearing. It cannot test whether the ASSERTION is. Where a fix pins the
row a test means, and the test still passes on the wrong row, the correct report is not "unproven"
and certainly not a manufactured red — it is that the assertion was never discriminating, which the
fix has now made it. Recorded here rather than smoothed into a 3-of-3 count.

**The mechanism, verified independently before being relied on** (see above): a row rewritten by an
`UPDATE` moves to the physical end of the heap, so an unordered sequential scan returns it last.
That is what makes `.at(-1)` pick the *oldest* row rather than the newest.
