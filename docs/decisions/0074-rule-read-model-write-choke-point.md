# ADR-0074 — An ordinary admin edit of a versioned rule must change what is ENFORCED, not only what is DISPLAYED

- **Status**: Accepted
- **Date**: 2026-08-09
- **Migration**: **none** — and that is a finding, not an omission. See §7.
- **Amends**: [ADR-0073](0073-rules-engine-versioning.md) (gap 10, closed and its description
  corrected) and, in one respect, [ADR-0048](0048-agent-prompt-policy-versioning.md) (the read-model
  write moves inside `activateVersion`'s transaction, which changes ordering on the agent
  system-prompt path too). Neither ADR is rewritten; ADR-0073 carries a dated amendment pointing
  here.

---

## 1. Context — the read-model acquired a second writer, and nothing stopped a third

ADR-0073 wired the rules engine through `config_versions`. The load-bearing line is
`apps/gateway/src/rule-versions.ts`:

```ts
const servedRow = res.served ? applyRuleBody(artifactType, row, res.served.body) : row;
```

From that line onward, the four rule tables — `approval_rules`, `rate_limits`, `data_scope_rules`,
`compliance_profiles` — stopped being the source of truth for their own **enforcing** columns and
became a **read-model**. `activateVersion` keeps that read-model in sync, so every listing surface
shows what is enforced without learning `config_versions` exists.

The consequence ADR-0073 disclosed as its gap 10, and left open: **any writer that mutates a
versioned column without minting a version produces silent divergence.** The admin sees the edit in
the row, in `GET /v1/rules/*`, and in the admin SPA. Enforcement never changes. There is no error,
no warning, and no artefact to find afterwards except the *absence* of a version row nobody thought
to look for.

**In a governance product that is worse than a refusal.** A refusal is a fact an operator can act
on. A 200 that lies is a fact they will act on wrongly, during an incident, believing they have
tightened a rule they have not.

### The three live writers

The sweep that preceded this ADR enumerated every reference to the four drizzle table symbols across
`apps/` and `packages/` — 97 non-test references in 14 files — rather than pattern-matching for
`.insert(`/`.update(`. That is what caught two upserts a regex would have classified as creates.

| route | file | fields | why it was live silent divergence |
| --- | --- | --- | --- |
| `PATCH /v1/rules/:kind/:ruleId/deploy-mode` | `org-settings.ts` | `deployMode` | `deployMode` is versioned for all three restriction types. Bare `db.update(table).set(...)` **through a module-local table map**, so a `.update(approvalRules)` grep never saw it. Wrote a confident audit row. One click on the rules list in the admin portal. |
| `POST /v1/compliance/profiles` | `projects.ts` | 12 versioned fields | **Not a create route** — `onConflictDoUpdate` on the UNIQUE `tag`, i.e. the *only* edit path a compliance profile has (there is no PATCH). `profilesForTags` resolves profiles through `config_versions`, so this silently under-enforced PII handling, MCP data-scope defaults, audit retention, budget ceilings, ADR-0042 guardrail floors and ADR-0068 red-team gating **at once**. Highest blast radius of the set. |
| `POST /v1/onboarding/compliance-pack` | `onboarding.ts` | 9 versioned fields | The same upsert. It computes `plan.profile: "update" \| "create"` in its own dry-run, so it *knew* it was overwriting, and reported `mode: "apply"` anyway. |

The three `POST /v1/rules/*` create routes are **not** part of this. They are pure inserts with
`defaultRandom()` ids and no unique constraint an `ON CONFLICT` could target, so the row they write
cannot have a version at the instant it is written: `resolveForShadow` returns `served: null` and the
raw row is served — byte-identical pre-ADR-0073 behaviour. ADR-0073's gap-10 text said a rule
"edited through the old CRUD surface" diverges, which implies a body-edit route that has never
existed. The amendment on that ADR corrects it.

### The part that made it non-uniform, and therefore worse

`RULE_BODY_SCHEMAS` make every field optional, so an active body may be **partial** and
`applyRuleBody` leaves an omitted field coming from the row. So for the deploy-mode PATCH:

- against an **auto-baselined** artifact (`ruleBodyFrom` copies every field with `?? null`, so the
  body always names `deployMode`) the write **vanished**;
- against a **hand-authored partial body** activated through `POST /v1/config-versions` that omits
  `deployMode`, the write **took effect**.

Both are wrong, and an admin could not tell which one they got from the 200 response.

---

## 2. Decision

**Every write to an enforcing column of a rule table goes through ONE function, which classifies the
patch by field class and mints + activates a version when — and only when — a versioned artifact's
enforcing field actually moves.**

`planRuleEdit` (pure, `packages/shared/src/config-versions.ts`) decides; `applyRuleEdit`
(`apps/gateway/src/rule-writes.ts`) executes. Four outcomes:

| outcome | when | what happens |
| --- | --- | --- |
| `row` | the patch touches no enforcing field, **or** the artifact has no version rows at all | plain row `UPDATE`, mint nothing |
| `no_change` | versioned, but the composed body equals what is already enforced | mint nothing; re-assert the read-model |
| `mint` | versioned, one active, composed body differs | mint **and activate**, atomically |
| `unresolvable` | version rows exist and **none** is active | **refuse, 409**, naming the activate route |

### 2.1 The `row` branch is two different invariants wearing one name

Not versioning a **selection** edit is ADR-0073 §2 honoured directly: `scope`, `serverScope`,
`userId`, `roleId`, `teamId`, `serverId` and a profile's `tag` decide *which callers a rule is loaded
for*, not what it does. Versioning one would create a rule simultaneously active and unreachable.
(No route edits selection today; this branch is future-proofing, and it is why the compliance
profile's `tag` — the upsert's conflict **key**, not an edited value — never reaches the mint path.)

Not versioning an edit to an **unversioned artifact** is invariant 4: a rule nobody has versioned
stays byte-identical to pre-ADR-0073 behaviour, and ADR-0073 §5's lazy baseline stays lazy. A naive
"mint on every CRUD write" would drag every install onto the version path through ordinary CRUD —
precisely the migration-time backfill ADR-0073 §5 refused.

### 2.2 Minted from the ACTIVE BODY, never from the row — the load-bearing line

The new body is `composeRuleBody(type, row, activeBody, patch)`, which layers **row → active body →
patch** and totalises the result through `ruleBodyFrom`. It is emphatically **not**
`ruleBodyFrom(type, rowAfterUpdate)`.

The row is a read-model that **may already have drifted**: every artifact that was versioned before
this ADR and then touched by one of the three writers above is drifted *right now*. Minting from the
row would promote that accumulated drift into an enforcing version — **the fix would ratify the
bug**. Composing onto the active body corrects the drift instead, and the audit row's diff then
states the true before/after. The row remains the layer underneath because a partial active body
legitimately inherits from it, exactly as `applyRuleBody` does at dispatch.

The minted body is **total** (every versionable field stated, `?? null`), so a later reader never has
to work out which layer a value came from — and the partial-body ambiguity described in §1 stops
accumulating.

### 2.3 Atomicity is structural, not a matched pair of writes

On the `mint` branch `applyRuleEdit` **never writes the enforcing columns itself**. It calls
`newVersion(..., activate: true)` and lets `activateVersion`'s own `writeRuleReadModel` produce the
row write. "The row and the served body agree" is therefore a property of the code path rather than
of two writes staying in step.

**And a related defect fixed in the same slice**: `activateVersion` wrote both read-models —
`agents.systemPrompt` (ADR-0048) and the rule row (ADR-0073) — **after** its transaction committed. A
crash in that window left the row disagreeing with the active version: the exact divergence this ADR
exists to remove, reachable with no bad writer involved at all. Both writes now run **inside** the
transaction.

### 2.4 Two honest refusals

- **`unresolvable` → 409.** Version rows exist and none is active. There is no authoritative base
  body to compose the patch onto, so minting would be a guess. Default-deny extends to **writes**,
  not only to reads. Critically, a CRUD write must **not** be allowed to repair an unresolvable
  artifact by activating something — that repair belongs on the explicit, audited activate route, and
  the 409's detail names it.
- **The composed body fails `validateRuleVersionBody` → 422.** Unreachable from today's zod-typed
  routes, and structurally required anyway: a body that cannot legally *be* a version cannot legally
  be an edit, and storing it would move a bad edit onto the served path as an outage.

### 2.5 Does auto-activation bypass a gate? No — answerable from code

`evaluatePromotion` gates **promoting a canary** — taking a shadow-measured candidate and making it
enforce. Direct activation has never been gated: `POST /v1/config-versions/:type/:id/activate` has no
eval gate whatsoever, and `newVersion(activate: true)` is the shipped, blessed pattern
(`POST /v1/agents/:agentId/system-prompt`). An admin who can call the deploy-mode PATCH could already
reach the identical end state in two ungated calls.

So auto-activation **restores pre-versioning semantics** — an entitled admin changes policy
immediately — and **adds history where there was none**. The activation lands with `action:
"activated"`, never `"promoted"`, so the ledger never reads a CRUD edit as a canary promotion.

---

## 3. The structural guard — because a point fix does not close a class

Three handlers were fixed. The deeper problem is that nothing prevented a fourth from appearing, and
the failure mode leaves no runtime artefact to catch. `rule-write-guard.test.ts`:

1. **Enumerates every drizzle `.insert(EXPR)` / `.update(EXPR)`** in every non-test gateway source
   file, where `EXPR` is either one of the four table symbols **or an identifier this scan cannot
   resolve to a table** — the dynamic case, which is exactly how the worst writer hid. The set is
   pinned against `AUDITED_WRITERS`, and every entry carries a written reason it is safe. A new
   writer, direct or through a variable, fails the build with a message naming `applyRuleEdit`.
2. **Refuses aliased imports** (`approvalRules as X`), which would defeat the scan.
3. **Refuses raw SQL writes** naming the snake_case tables.
4. **Pins that only `rule-writes.ts` and `agents-connectors.ts` import `newVersion`** — any other
   importer is a second minting path, which is how the class comes back.
5. A companion test in `rule-write-versioning.test.ts` **pins the create-only property** of the three
   `POST /v1/rules/*` routes (POST twice → two rows). Their benign classification is a property of
   the routes being create-only, and nothing enforced it before.

The guard was verified by attack: adding a bare `db.update(complianceProfiles).set(...)` to an
unrelated file makes it red, naming the file.

---

## 4. The shadow canary's baseline moved — mark it, gate the promotion, never the edit

This ADR lets an ordinary admin edit mint and activate a version. That **moves the baseline** a
running shadow canary is being compared against, so a seam that was hypothetical under ADR-0073 is
now routine.

**A live read-side defect ADR-0073 already had**, independent of the write fix:
`config_canary_observations` stores `active_version_id` per row, but **both** read surfaces —
`GET …/divergence` and `GET /v1/config-versions/canaries` — aggregated on `candidate_version_id`
**alone**. Observations taken against baseline v3 and v4 pooled into one `diverged` count with no
seam: the number's shape unchanged, its meaning changed, and it flowed into a promotion decision.
That is [ADR-0072](0072-scoring-semantics-correction.md) §1's bug class verbatim.

The posture is ADR-0072's, verbatim: **mark history, never rewrite it, and refuse the COMPARISON
rather than the CHANGE.**

1. **Written observations are never touched.** No delete, no recompute, no backfill. They already
   carry their baseline.
2. **Every aggregate is keyed on `(candidateVersionId, activeVersionId)`.** A pure query-level fix —
   the column already exists, which is most of why this ADR needs no migration.
3. **The stranded set is reported, not hidden.** `/divergence` leads with the current pair's totals
   and separately discloses prior-baseline observations with their count, their version numbers and
   the reason. ADR-0072 §3.2 case 1's rule: "you have no history" and "your history predates the
   correction" must never be the same sentence.
4. **The seam is recorded in the ledger.** An activation while a canary is in flight writes
   `activated while version N was canarying at P% — the shadow comparison baseline moved here` on the
   `config_activation_events` row and in the audit row's detail.
5. **The promotion gate refuses on a stale sample.** `POST …/promote` runs
   `evaluateBaselineFreshness` *ahead of* the eval gate: if any observation was measured against a
   version that is not the current active, promotion is refused with
   `canary-promote-stale-baseline`, naming the counts on each side and the two honest exits —
   re-point the canary (a fresh comparison window) or override **with a reason**. It does **not**
   silently re-scope the promotion to the post-seam subset: a human chose that comparison
   (ADR-0072 §3.2 case 3, same reasoning).

**A NULL `activeVersionId` is treated as NOT comparable**, never as a match. Rows written before an
artifact had an active version carry null, and bucketing them with the current baseline would fail
*towards allowing* a promotion on an unattributable sample — the wrong direction.

**The gate lands on the PROMOTION, never on the EDIT.** An urgent policy change is never blocked by a
running measurement; the only thing that becomes harder is *acting on* a measurement whose baseline
moved, which is precisely the thing that should be hard.

`/divergence` additionally renders the candidate's **effective** body (`applyRuleBody` of the
candidate over the active over the row) and names the inherited fields, because a partial candidate
body is not what was evaluated.

---

## 5. Orphaned versions — the operator surface stops lying

`config_versions.artifact_id` is **polymorphic across five artifact types** and therefore carries no
foreign key (migration 0060 confirms: the only FK is `author_user_id`). The rule tables meanwhile
cascade on `user_id` / `server_id` / `role_id` / `team_id` — and `approval_rules.approver_user_id`
too, so **deleting an approver deletes the rule**. There are no DELETE routes for rule types at all,
so this is the *only* way a rule disappears.

When it does, its `config_versions` rows remain, one of them still `active`. Consequences today:

- `GET /v1/config-versions/canaries` listed the orphan in the operator's "there is something waiting
  on you" index **for ever**, with counts that can never move, and there is no DELETE route on
  `config_versions` anywhere;
- `GET /v1/config-versions/:type/:id` returned a full lineage with an active version and a canary
  mode — a 200 that reads as a live governed artifact.

The strongest evidence this was unintentional: ADR-0073's own test teardown hand-deletes
observations, activation events and versions by `artifactId` before deleting the rule. The author had
to hand-roll the cascade because there isn't one.

**What is NOT harm, stated plainly**: an orphaned version can never enforce. `applyRuleVersions` only
resolves versions for rows the scoped SQL pre-filter actually loaded, and a deleted row is never
loaded. This is a lying operator surface and dangling storage, not a governance bypass.

**Decision: disclose at the read surfaces now; do not delete, and do not add a cascade.** Both
endpoints resolve artifact existence and say `artifactDeleted: true` in words. The version rows and
the activation ledger are kept **deliberately** — they are the record of what governed the calls made
while the rule existed, exactly as `config_canary_observations` is already FK-free for the same
reason. Deleting them to tidy a dashboard is ADR-0072 §4's rejected alternative applied here.

The correct *end* state is a tombstone: an `AFTER DELETE` trigger per rule table that demotes the
pointers out of the active/canary space and appends a deletion event. That touches
`CONFIG_VERSION_STATUSES` and both partial unique indexes, so it is its own slice with its own
migration. Named, not done.

---

## 6. Alternatives rejected

- **(B) Refuse every read-model write on a versioned artifact with a 409.** Honest, and honesty is
  the house rule — but it makes versioning a **one-way trap**: versioning a rule *once* permanently
  breaks the ordinary admin surface for it. Concretely it would 409 the onboarding compliance pack
  for any org that had ever versioned that profile, breaking the pillar-3 fast-start path. It fails
  the "restores pre-versioning semantics" test (one call becomes three, having first discovered that
  `config_versions` exists), and it buys nothing A' does not: the end state reached through the
  versioning API is byte-identical to what A' mints. Kept only for the two cases in §2.4 where there
  is genuinely no right answer.
- **(C) Supersede/deactivate the active version so the row is served again.** Refutable from code
  rather than on principle: `resolveForShadow` short-circuits only on `versions.length === 0`. After
  (C) the artifact still has version rows and now has **no active one**, which is the fail-closed
  branch — it converts an ordinary admin edit into a **fleet-wide DENY**. To actually make the row
  serve it would have to DELETE every version row, destroying immutable history (ADR-0048 property
  1). Not endorsed in any form.
- **Naive (A) — "any read-model write mints and activates", undecomposed.** Breaks ADR-0073 §2 (a
  selection-only edit would mint a version whose body must exclude selection fields — an empty or
  no-op body plus a ledger row claiming policy changed), breaks invariant 4 (minting on unversioned
  artifacts), and minted from the resulting row rather than the active body it ratifies existing
  drift.
- **Refusing the edit while a canary is running.** Lets a **measurement** block a **policy change**.
  An operator tightening an approval rule during an incident would be told to abandon their shadow
  canary first. The canary is the disposable thing; enforcement is not.
- **Auto-invalidating or auto-abandoning the canary when the baseline moves.** Silently discards an
  operator's proposal and marks it `rolled_back` — a status that misstates its history, since it was
  never active — and throws away observations that remain **true statements about the baseline they
  were measured against**. ADR-0072 §4 rejected the isomorphic move.
- **Silently re-scoping a promotion to the post-seam observations.** A human chose that comparison.
  Substituting another one is an answer to a question nobody asked.
- **Merging rather than replacing on `POST /v1/compliance/profiles`.** That route has always had
  total-replace semantics (`values` fills every optional field with `?? null`). Changing that here
  would be a second, unrequested behaviour change hidden inside a versioning fix. It is now
  *expressed as a version*, so the replacement is visible and rollback-able instead of invisible.
  Disclosed in §8.

---

## 7. Migration: none, and why that is a finding

Every column this ADR needs already exists. `config_canary_observations.active_version_id` was
already written by ADR-0073's shadow pass — **the data to separate the baselines was being stored and
thrown away at read time.** The re-keying is a pure query change. `audit_log.object_type` gained
`compliance_profile`, which is a TS-only enum on a plain `text` column (migration 0027 states the
convention explicitly), so no DDL.

Writing a migration here would have been ceremony. ADR-0071 set the precedent of correctly needing
none.

---

## 8. Consequences

- **Editing `deployMode` on a versioned rule now changes what the kernel decides**, proved end to end
  through a real governed call rather than by reading a column.
- **Editing a versioned compliance profile now changes the §8.3 cascade** — PII mode, MCP default,
  retention, budget ceiling, guardrail floor, red-team gating.
- **Ordinary admin edits now create version history.** `config_versions` grows on rule CRUD where it
  previously did not. The `no_change` branch is what keeps that proportionate: an idempotent re-apply
  (the onboarding pack is *designed* to be re-run) mints nothing and writes no activation event.
- **`POST /v1/compliance/profiles` keeps its total-replace semantics**, which means re-POSTing
  without an optional field still clears it — now as a minted version rather than as an invisible row
  write. The onboarding pack deliberately passes only the nine fields it means to write, so the three
  `redteam*` fields survive a pack re-apply exactly as they did before.
- **A new hard failure**: promoting a canary whose sample spans a baseline move is refused
  (`canary-promote-stale-baseline`) on a path that previously always succeeded for rule types. The
  exits are re-pointing the canary or an audited override with a reason. Called out here the way
  ADR-0072 §5 called out its own.
- **Existing divergence totals will drop** for any artifact whose baseline ever moved. That is the
  correction, not a regression — and the endpoint says which pair the totals are for rather than just
  showing a smaller number.
- **Read-model writes moved inside `activateVersion`'s transaction**, which changes ordering for the
  ADR-0048 agent system-prompt path as well as for rules.

---

## 9. Disclosed rather than closed

1. **Operational bypasses remain.** A manual `psql` session, a `pg_restore` of a backup taken before
   an artifact was versioned, or an air-gapped update bundle shipping a database dump all
   desynchronise a row from its active version with no application code involved. Nothing in the
   schema prevents it: there is **no FK, trigger or CHECK** tying a rule row's versioned columns to
   its active body. The three DB invariants that do exist constrain `config_versions` only. The
   choke point closes the application path; it cannot close this one.
2. **Existing drift is corrected opportunistically, not swept.** An artifact that a pre-0074 writer
   desynchronised is repaired the next time it is edited (composing onto the active body) or
   activated. There is **no backfill and no drift report** naming every currently-drifted artifact.
   A sweep endpoint would be genuinely useful and is not in this slice.
3. **The `no_change` branch re-asserts the read-model but is not a general repair path.** It fixes
   drift only for the artifact being edited, and only when the edit reaches it.
4. **Partial version bodies are still authorable** through `POST /v1/config-versions`, so the
   ambiguity in §1 can still be created deliberately. New bodies minted by `applyRuleEdit` are
   always total, and `/divergence` now renders the candidate's effective body — but nothing forbids
   a partial body.
5. **The read-side asymmetry ADR-0073 left is untouched.** `profilesForTags` fails closed when a
   profile is unresolvable, but four consumers read `compliance_profiles` rows **raw** and skip
   resolution entirely — `redteam.ts` (red-team preset), `cost-import.ts` (`orgPiiFloor`),
   `compliance-packs.ts` (a coverage COUNT), `setup-status.ts` (a tag list). Because
   `activateVersion` keeps the read-model in sync they agree with enforcement in the normal case, but
   in the **unresolvable** case they proceed on the stale row while the cascade denies — fail-OPEN in
   the same state the cascade fails closed. Found while sweeping, out of scope here, not verified for
   how far it propagates.
6. **Orphaned versions are disclosed, not tombstoned.** §5. An orphaned `active` version would be
   inherited by a resurrected artifact of the same id — not reachable in practice with random v4
   uuids, and stated here rather than coded against.
7. **A concurrent create/edit race is narrowed, not eliminated.** The compliance-profile routes now
   use `onConflictDoNothing` and fall through to the edit path, so a concurrent create cannot clobber
   a versioned profile. Two concurrent *edits* still race in the ordinary last-writer-wins way; the
   partial unique index on `status='active'` means one of them fails loudly rather than both
   succeeding.
8. **The guard is a source scan.** It cannot see `.claude/worktrees/`, generated code, or a writer
   introduced in a package outside `apps/gateway/src`. Its file-set is exactly the gateway's own
   sources, which is where every writer found by the sweep lives.
9. **Test-only direct writes are excluded by design.** Four existing suites insert into these tables
   as fixtures. They are not product code, and excluding them is what lets them keep constructing
   row+version states no route can — which is how the fail-closed branches are tested at all.
10. **`agent_config` remains vocabulary only** and the compliance-profile shadow is still computed at
    read time over the first 50 tagged projects — both inherited unchanged from ADR-0073.
11. **Nothing here is proven against a real model provider**, which remains true of the whole
    product. It does not bear on this slice: the rules engine is deterministic and
    provider-independent.

---

## 10. What is GENUINELY ENFORCED

`apps/gateway/src/rule-write-versioning.test.ts` (15 cases) and
`apps/gateway/src/rule-write-guard.test.ts` (6 cases), plus 14 new pure cases in
`packages/shared/src/config-versions.test.ts`.

- **THE ASSERTION IS ALWAYS A DECISION, NEVER A COLUMN.** A test that checked "the row now says
  air_gapped" or "a version row exists" would have **passed against the broken code**. Every claim
  here is made through `POST /v1/evaluate`. Verified by attack: with the fix disabled, **12 of the 15
  cases fail**.
- **THE DEFECT IS PINNED IN BOTH DIRECTIONS.** Two identical approval rules pause the same call; one
  is versioned, one is not. Scoping the versioned one to `air_gapped` through the PATCH mints v3 and
  the kernel stops applying it — the decision now names the *other* rule. Scoping the unversioned one
  mints **nothing** (invariant 4) and the decision becomes `allow`.
- **THE MINTED VERSION IS ROLLBACK-ABLE.** Roll back → the rule binds again; re-activate → it does
  not. The edit gained a history it did not have.
- **AN IDEMPOTENT RE-APPLY MINTS NOTHING** and says so, so the ledger does not fill with moves that
  changed nothing.
- **THE UNRESOLVABLE REFUSAL NAMES THE REMEDY** — 409, with the activate endpoint in the detail.
- **THE COMPLIANCE UPSERT CHANGES THE CASCADE**, asserted through `GET
  /v1/projects/:id/compliance`, and the onboarding pack re-applied over a versioned profile mints
  rather than silently overwriting — while a genuine pack *create* mints nothing.
- **THE BASELINE SEAM.** An edit during a canary is **not refused** and the canary is **not
  abandoned**; the ledger row carries `the shadow comparison baseline moved here`; `/divergence`
  separates the stranded observations from the totals; promotion is **refused** with
  `canary-promote-stale-baseline`; an override with a reason is allowed and the ledger says
  `MIXED-BASELINE`.
- **ADR-0073's INVARIANT SURVIVES.** Every divergent observation this suite produced has
  `servedEffect !== candidateEffect`, and the served side is always the active version's answer —
  the shadow never reached the served decision.
- **THE CREATE ROUTES ARE CREATE-ONLY**, pinned for the first time.
- **THE DRIFT CASE IS PINNED PURELY**: a row saying `maxCalls: 999` (a pre-0074 discarded write) over
  an active body saying `10`, patched on an unrelated field, mints a body saying **10**. Minting
  from the row would have ratified the bug.
- **A NULL BASELINE IS NOT COMPARABLE**, asserted directly, because the failure direction matters.
- **THE GUARD CATCHES A REINTRODUCTION**, verified by adding a bare
  `db.update(complianceProfiles)` to an unrelated file and watching it go red.

---

## 11. Verification

Full gateway suite on a **freshly created database**, plus every package suite:

| suite | before | after |
| --- | --- | --- |
| gateway | 1,968 tests / 113 files | **1,989 / 115** |
| `@regulait/shared` | 579 | **593** |
| policy-kernel | 129 | 129 |
| model-provider | 122 | 122 |
| infra-provider | 174 | 174 |
| training-provider | 58 | 58 |
| workflow-kernel | 39 | 39 |
| orchestration-kernel | 27 | 27 |
| optimizer-kernel | 69 | 69 |
| pm-provider | 62 | 62 |
| git-provider | 51 | 51 |
| connector-provider | 58 | 58 |
| Playwright | 86 | **88** |

The gateway's +21 is 15 from `rule-write-versioning.test.ts` and 6 from `rule-write-guard.test.ts`;
no existing gateway test was rewritten. The shared package's +14 is entirely new cases for
`planRuleEdit`, `assessCanaryBaseline` and `evaluateBaselineFreshness`.

`pnpm -r build`, `pnpm --filter @regulait/web build` and `pnpm -r typecheck` are clean.

---

## Amendment — 2026-08-09: the structural guard was NOT complete, and said it was

Three independent adversarial verifiers reviewed this ADR as shipped. Two found the
mint-on-write core sound. The third returned **defective**, and it was right: the guard in
`rule-write-guard.test.ts` did **not** close the class, while this document and the index row
said it did. In a governance product an Accepted ADR asserting a false safety property is worse
than the defect it documents, because it stops the next person looking.

Two demonstrated bypasses, both since fixed:

1. **The audit was a SET of `file|method|expr` triples**, compared by set difference. That detects
   a new *shape* and is blind to a new *writer*: three audited entries carry the generic expression
   text `table`, so a **second** `db.update(table)` added to a file that already had one collided
   with an existing triple and passed untouched. A verifier demonstrated it with a new
   `PATCH /v1/rules/:kind/:id/tool-name` route writing the **versioned** `toolName`.
   Writers are now **counted**, and a mismatch fails in **both** directions — an added writer
   raises the count, a removed one lowers it and is reported as a stale entry.

2. **The write regex required a BARE IDENTIFIER argument**, so `db.update(schema.complianceProfiles)`
   (valid — the db package re-exports `schema`), `db.update(RULE_TABLES[kind])` and
   `db.update(tableFor(kind))` were invisible. The middle one is *exactly the shape the original
   ADR-0073 defect had*. The scan now captures any argument expression and **fails closed**: an
   expression it cannot statically resolve to a table is pinned as if it were a rule-table write.
   That direction is deliberate and is the same correction ADR-0072 made to
   `classifyDispatchFailure` — an unrecognised thing treated as safe is a fail-OPEN in a safety
   check.

**Fixing the scan immediately found a real gap the old one had been hiding**: `rule-writes.ts`
contains **three** `db.update(table)` calls — one per branch of `applyRuleEdit` — and only one was
audited. The set-based guard had collapsed them and would not have noticed a fourth.

**Verified by attack.** All three bypasses were re-run against the corrected guard and each now
makes it fail: a duplicate `db.update(table)` in an audited file; `db.update(schema.complianceProfiles)`;
and `db.update(MAP[kind])`.

### What the guard can and cannot see — stated precisely, replacing any earlier claim

**It CAN see**: any `.insert(EXPR)` / `.update(EXPR)` in a non-test `.ts` file under
`apps/gateway/src`, whatever `EXPR` is, including dynamic and namespaced references; a change in the
NUMBER of such writes; an audited entry that no longer exists; an aliased import of the four tables;
and raw SQL naming the four tables.

**It CANNOT see**: a write from **outside** `apps/gateway/src` (other packages, migrations executing
DML, anything running against the database directly); a write assembled so the call site is not
syntactically `X.insert(...)`/`X.update(...)` (a builder held in a variable and invoked later, a
`Reflect`/dynamic dispatch); or anything reaching Postgres without going through this codebase at
all. It is a **source enumeration**, not a runtime interceptor, and it proves the *list is complete
and each entry was reasoned about* — never that a listed writer is correct. Correctness is
`rule-write-versioning.test.ts`'s job, and it asserts through the kernel.

The honest claim is therefore: **the class is closed for writers inside the gateway's own source
tree, by an enumeration that fails closed on anything it cannot resolve.** It is not, and cannot be,
a guarantee about writes that never pass through this code.
