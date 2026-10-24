# ADR-0107 — An unordered single-row read is a correctness bug, not a test-flake nuisance

- **Status**: Accepted
- **Date**: 2026-09-09
- **Relates to**: [ADR-0105](0105-consent-context-binding-and-expiry.md) (whose fix for the
  approved-approval lookup — `asc(requestedAt)` for FIFO consent — is the shape every fix below
  follows, and whose §1 already states the inverse rule: a read whose result must NOT depend on
  order is owed no `ORDER BY`), [ADR-0106](0106-mock-socket-net-contract.md) (the other half of
  "the suite's result is a fact, not a coin flip" — 0106 fixed an exit code that lied, this fixes
  answers that varied), [ADR-0073](0073-rules-engine-versioning.md) and
  [ADR-0104](0104-approval-payload-binding.md) (the approvals machinery several of these sites
  read)
- **Migration**: **none.** Deliberately — see "What this deliberately does NOT do".

## Context

Four intermittent test failures were found in four consecutive batches. Every one was found by an
independent re-run rather than by the build that introduced it, and every one was the same disease:

> **a query that does not ask for an order, whose caller then depends on one.**

Postgres guarantees no row order without `ORDER BY`. Not "usually insertion order", not "usually
the index order" — none. The physical order a sequential scan returns depends on the heap, on
whether a row has been updated (and therefore rewritten at the end), on autovacuum, on whether the
planner chose a bitmap scan, and on how many workers it parallelised across. All of those change
under load, which is exactly why the failures were intermittent and why they surfaced on re-runs
rather than on the run that shipped them.

Two were fixed reactively:

| where | what it did |
| --- | --- |
| `use-cases-eu-tier.test.ts` (fixed `0ebfabe`) | a helper selected with no `ORDER BY`; the caller indexed `.at(-1)` |
| `governed-evaluate.ts` (fixed inside ADR-0105) | the approved-approval lookup was `.limit(1)` with **no `ORDER BY`** — an arbitrary row decided an authorization outcome |

**Read that second row again.** It is not a flaky test. It is a governance decision made by
whichever row the planner reached first. This ADR is the proactive version of that fix: the same
defect, hunted rather than waited for.

### The scan

`apps/gateway/src/**/*.ts` and `packages/**/*.ts` (excluding `node_modules`, `dist`) were scanned
for the two shapes that consume exactly one row:

- `const [x] = await db.select(...)...;` with **no `.orderBy(`**
- `db.select(...)....limit(1)...;` with **no `.orderBy(`**

then excluding aggregate selects (`count()`, `sum(`, `avg(`, `max(`, `min(`, `coalesce(`), which
return exactly one row by definition; known singleton tables; and predicates pinned to a primary
key (`eq(t.id, …)`).

**286 candidates: 142 production, 144 test.** The coordinator's independent scan of the same tree
found 296 (146/150). The ~3% gap is regex reach, not disagreement about any site — this scan
resolves the receiver of `.select(` (so a `tx.select(…)` inside a transaction is counted and a
`.select(` on a non-`Db` object is not) and it treats the drizzle **singleton and aggregate**
exclusion lists slightly differently. No site classified below was reachable only in one of the two
scans; the disagreement is entirely in the excluded population.

### How uniqueness was established — measured, not assumed

A candidate is **benign** when its predicate can match at most one row. Most of the remaining ones
look like `eq(agents.name, …)`, `eq(schedulerJobs.name, …)`,
`and(eq(mcpTools.serverId, …), eq(mcpTools.name, …))` — safe **only if a UNIQUE constraint or unique
index actually backs that column or column pair**. A `name` column without a unique index is
exactly the trap, and "it is called `name`, so it must be unique" is exactly how a sweep like this
produces a false clean bill of health.

So uniqueness was not read off the column names, and not read off `schema.ts` either. **All 107
migrations were applied to a fresh database and `pg_index` was queried directly**, which is the only
artefact that knows what the running system actually enforces. That produced 274 total unique
indexes and, separately, **16 PARTIAL unique indexes** (`CREATE UNIQUE INDEX … WHERE …`) — the ones
schema-reading would most easily have gotten wrong in both directions:

- a partial index makes a site look unprotected when it is not — `compliance_packs_one_active_uq ON
  (framework) WHERE status = 'active'` exactly covers `and(eq(framework, …), eq(status, "active"))`;
- and it makes a site look protected when it is not — `guardrail_configs_org_uq ON (scope) WHERE
  scope_id IS NULL` does **not** cover a bare `eq(scope, "org")`, which is one of the bugs found
  below.

Each of the 142 production candidates was then checked mechanically against that map, and every
candidate the check could not clear was read by hand with its caller.

## Decision

**Every production site where the predicate can match more than one row AND the code then depends
on which row it got is given a deterministic total order. Nothing else is touched.**

### The discriminator, stated so it can be applied again

A candidate is **real** when BOTH hold:

1. the predicate can match more than one row, **and**
2. the code then depends on *which* row it got — it reads fields, makes a decision, returns it, or
   asserts on it.

If it can match many rows but the code only checks **existence** (`if (row) …`), that is benign, and
adding an `ORDER BY` to it would be worse than leaving it: it tells the next reader that ordering
mattered here, and it costs a sort on a hot path to answer a question that does not need one. The
approvals queue's `if (!pending) insert(...)` dedup guards are the largest group in that bucket and
they are deliberately left alone.

### Total, not merely deterministic

Every order added is a **total** order. A tiebreak on `created_at` alone is not one: two rows
written in the same transaction can carry the same `now()`, and a sort with ties re-admits exactly
the nondeterminism being removed. Every fix therefore ends in `id`. ADR-0105's `asc(requestedAt)`
predates this rule and is a genuine, if narrow, residue — it is noted in "Honest limits" rather
than quietly amended here.

### The classification table

| | production | test |
| --- | ---: | ---: |
| candidates found | **142** | **144** |
| **benign** — provably backed by a unique/partial-unique index covering the predicate | 78 | 41 |
| **benign** — reviewed by hand: existence-only checks, singleton tables, raw-SQL predicates covering a real unique key | 34 | — |
| **FIXED** — the wrong row was reachable and the code depended on it | **19** | 0 |
| **DEFERRED** — the right fix is a UNIQUE CONSTRAINT, so no code change here | 11 | — |
| **classified, not fixed this batch** | — | 103 |

#### The 19 production fixes

| # | site | what could match twice | order chosen, and the intent it encodes |
| --- | --- | --- | --- |
| 1 | `regulait-llm.ts` `resolveArtifactProviderForDispatch` | `training_artifacts` is UNIQUE on `job_id`, **not** on `agent_id` — a retrain registers a second artifact against the same agent | `desc(createdAt), desc(id)` — newest-registered wins; registering an artifact against an agent *is* the act of saying "serve this one now" |
| 2–6 | `pm.ts` ×5 (`mirrorNodeStatus`, approval mirror, workflow-instance link, inbound webhook, decision parent-link) | `pm_links_conn_obj_node_uq` is `(connection_id, object_type, object_id, node_id)` — **connection first**, and none of these predicates names a connection. Pillar 8 is deliberately multi-provider, so one run node linked in both Azure DevOps and Jira has two rows | `asc(createdAt), asc(id)` — oldest link wins; the first tool an object was linked into is the one tracking it |
| 7–9 | `infra.ts` ×3 (action decision, action proposal, cert-rotation stamp) | the natural key of `infra_findings` is `(resource_id, kind, detail->>'signature')`, **not** `(ref_table, ref_id)` — a re-scan that observes a changed signature raises a second finding against the same ledger row | `desc(detectedAt), desc(id)` — the live finding is the one the latest scan raised |
| 10 | `orchestration.ts` run-span close | a trace may carry more than one `run` span; nothing constrains it to one | `asc(seq), asc(id)` — `seq` is the trace's own monotonic column; the lowest one *is* the root |
| 11 | `delegations.ts` `activeDelegationFrom` | overlapping delegation WINDOWS from the same person to the same person are legal and unconstrained | `desc(startsAt), desc(id)` — the latest instruction is the one in force |
| 12 | `chatops.ts` approval mirror | `chatops_connections` is UNIQUE on `name`, not on `enabled`; Slack and Teams can both be on | `asc(createdAt), asc(id)` — the first-configured connection is the default; an operator who wants another names it |
| 13–16 | `infra.ts` ×2, `scheduler.ts`, `scheduler-health.ts` — the "fall back to a real admin" actor | `is_admin` is not unique, and "any user" certainly is not | `asc(createdAt), asc(id)` — the deployment's bootstrap operator |
| 17–18 | `auth.ts` `loadUserByEmail`, `scim.ts` `loadUserByEmail` | `users_email_unique` is on `email` **exactly**; these lookups case-fold, so two legal case-variant rows both match | `asc(createdAt), asc(id)` — first registration owns the address. **See "semantic choices" below; this one is a stopgap, not the fix** |
| 19 | `mrm-autofill.ts` org guardrail default | `guardrail_configs_org_uq` is `(scope) WHERE scope_id IS NULL`; the predicate was a bare `eq(scope, "org")`, outside that index | **not an `ORDER BY`** — the predicate is tightened with `isNull(scopeId)` to match `guardrails.ts`'s canonical `loadOrgGuardrailConfig`, which makes it *provably* single-row rather than an ordered guess at one |

#### The 11 deferred — where a UNIQUE CONSTRAINT, not an `ORDER BY`, is the right fix

These are reverse lookups by the id of a structurally 1:1 partner record, or insert-if-absent
idempotency guards that already self-enforce except under a race. Ordering them would **encode the
wrong claim**: it would say "several of these are expected and here is the tiebreak", when the truth
is "a second one is a bug the database should have refused". They are left exactly as they are.

| table | column(s) that should be unique | sites |
| --- | --- | --- |
| `grant_certification_items` | `approval_id` | `grant-certification.ts` ×2 |
| `model_card_approvals` | `approval_id` | `mrm.ts` |
| `training_jobs` | `approval_id` | `regulait-llm.ts` |
| `sod_override_requests` | `approval_id` | `sod.ts` ×2 |
| `ai_use_cases` | `workflow_instance_id` | `use-cases.ts` |
| `ai_vendors` | `workflow_instance_id` | `vendors.ts` |
| `cert_inventory` | `(resource_id, common_name)` | `infra.ts` |
| `backup_runs` | `(finding_id, kind, status)` (partial, `WHERE status='missed'`) | `infra.ts` |
| `trace_spans` | `(trace_id, run_id)` partial, `WHERE kind='run'` | `orchestration.ts` |
| `users` | `lower(email)` — a FUNCTIONAL unique index | `auth.ts`, `scim.ts` |
| `data_key_state` | a single-row check constraint (it is a singleton by convention only) | `data-key.ts`, `data-key-reencrypt.ts` ×2 |

Each needs its own decision, because each is a schema change that can **fail on existing data** —
if a deployment already holds two rows the constraint forbids, the migration does not apply and the
question of what to do with the duplicates is a product question, not a mechanical one.

### Sites where the order is a SEMANTIC choice, not a mechanical one

Flagged rather than decided silently, because in each of these a user could in principle notice
which row won. In all five the *previous* behaviour was "arbitrary", so none of them is a
regression — but none is a neutral formatting change either:

1. **`auth.ts` / `scim.ts` — which account logs in.** With two case-variant rows, this now
   authenticates as the older one. That is deterministic, and it is still not *right*: the right
   answer is that the second row should never have existed. Called out first because it is the one
   with a security-shaped consequence, and the deferred `lower(email)` unique index is its real fix.
2. **`regulait-llm.ts` — which model answers.** Newest-wins matches how a retrain is shipped, but a
   deployment that registered a newer artifact it did not intend to serve will now see it serve.
3. **`pm.ts` — which external tool receives a mirror.** Oldest-wins was chosen over newest-wins
   because a link's age is the closest thing to "this is the tool that has been tracking this
   object". **Mirroring into *every* matching link is arguably more correct and is NOT done here**:
   that is a behaviour change with an external side effect per link, and it belongs to a decision
   about multi-tool mirroring, not to a determinism sweep.
4. **`chatops.ts` — which chat workspace gets the approval card.** Same shape as (3).
5. **`infra.ts` / `scheduler*.ts` — which admin an unattributed act is audited against.** Now the
   oldest admin rather than an arbitrary one. An audit trail that names a different person on two
   identical runs is not an audit trail, so this is an improvement; it is listed because it does
   change a name that appears in `audit_log`.

## What this deliberately does NOT do

- **No migration, and no `drizzle-kit generate`.** The eleven unique constraints above are the
  single most valuable follow-up in this batch and they are all *out of scope for it*. A schema
  change needs its own decision and its own answer to "what happens to a deployment that already
  violates it".
- **It does not touch a benign site.** 112 of the 142 production candidates are correct as written
  and stay untouched. Adding `ORDER BY` to a genuinely single-row lookup is noise that makes the
  next reader believe ordering mattered, and it makes the *real* fixes harder to see.
- **It does not fix the 103 at-risk test sites.** They are classified and reported, not edited —
  see "Honest limits". Production first, because production sites are correctness bugs and test
  sites are, at worst, future flakes.
- **It does not change behaviour beyond determinism.** No site now returns *more* rows, refuses a
  call it used to allow, or mirrors to more places than before.
- **It does not re-litigate ADR-0105 §1's inverse rule.** A read whose result must not depend on row
  order is still owed no `ORDER BY`, and the rule-load in the context digest is still deliberately
  unordered. That is the same principle from the other side, not an exception to this one.

## Honest limits

- **This is a partial sweep, and the partition is stated rather than blurred.** Production is done:
  all 142 candidates classified, 19 fixed, 11 deferred with the reason. **The 103 at-risk test sites
  are classified but NOT fixed.** They cluster in `cost-import.test.ts` (9), `spend-monitor.test.ts`
  (8), `data-key-custody.test.ts` (7) and `shadow-ai-adapters.test.ts` (7), over `audit_log` (15),
  `shadow_ai_findings` (12) and `imported_cost_lines` (11) — i.e. exactly the shape of the two
  flakes already found. Each is a latent intermittent. A follow-up batch owes them the same
  treatment.
- **The scan finds two syntactic shapes, and a bug can be written in a third.** `.at(-1)`,
  `rows[0]` on a plain array, a `sql.raw` query, and `Promise.all([...])` destructuring are not
  matched. The `use-cases-eu-tier.test.ts` flake was itself an `.at(-1)`, so this class is known to
  be real and is known to be unswept.
- **"Can match more than one row" was judged from the schema, not proved by construction.** For the
  eleven deferred sites the second row is *structurally* possible but may be unreachable through
  any code path that exists today. That is precisely why they get a constraint rather than a
  tiebreak — a constraint states and enforces the belief, where an `ORDER BY` only accommodates its
  failure.
- **The tests below cover 3 of the 19 fixes, and the report does not claim more.** Those three are
  the ones whose wrong row is reachable through an exported function with a plain DB fixture. The
  `pm.ts` and `infra.ts` fixes would each need a fake external provider and a multi-connection
  fixture to redden; the two `lower(email)` sites are covered, the four actor-fallback sites are
  behind unexported helpers, and `mrm-autofill` is covered by its existing suite only for the
  unchanged case. **Sixteen of the nineteen fixes are argued from the schema and reviewed by hand,
  not pinned by a new test.**
- **ADR-0105's `asc(requestedAt)` is not a total order.** Two approvals queued in the same
  transaction tie, and the tie is broken by the planner. It is a narrower window than the one 0105
  closed and it is left alone here rather than amended in passing.
- **`data_key_state` is a singleton by convention only.** Nothing in the database enforces one row.
  It is treated as a singleton at three sites and is listed for a constraint.

## Non-vacuity (M-002, measured)

Two of the three new tests had their `ORDER BY` **reverted in place** — the fixture, the assertion
and the surrounding code left exactly as they are, so only the acting-on-the-order stopped:

- `regulait-llm.ts` — `.orderBy(desc(createdAt), desc(id))` removed from
  `resolveArtifactProviderForDispatch`;
- `delegations.ts` — `.orderBy(desc(startsAt), desc(id))` removed from `activeDelegationFrom`.

Each fixture deliberately inserts its rows in the order **opposite** to the one the fix must return,
so an unordered read on a freshly created database returns the row Postgres physically wrote first —
the wrong one.

Run against a **freshly created database**: **2 failed | 1 passed**.

| test | result under the neutralised order | what that proves |
| --- | --- | --- |
| newest training artifact is dispatched | **RED** — `expected '…4603' to be '…e83'`, i.e. the STALE artifact was served | the model an inference call reaches was genuinely arbitrary |
| latest delegation window wins | **RED** — the superseded window's row was returned | the `reason` on the audit trail named the wrong delegation |
| case-folded email resolves to the same account twice | **GREEN**, correctly | the negative control: this assertion must survive a neutralised order, because two calls on an untouched heap do agree. A red here would have meant the test was measuring its fixture |

The probe was reverted exactly (`git checkout` of both files against the committed tree; `git
status` clean apart from the new test file and this ADR).

The third test — the case-folded email lookup — was left ordered during the probe as a **negative
control**: it asserts the *same answer twice* as well as a specific answer, and the same-answer-twice
half must stay green under a neutralised order, because two calls in quick succession on an
untouched heap generally do agree. A test that reddened there would have meant the assertion was
measuring the fixture rather than the fix.
