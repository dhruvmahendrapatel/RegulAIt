# ADR-0073: Wire the rules engine through `config_versions` — the ACTIVE version enforces, the CANDIDATE is genuinely shadowed

- **Status**: Accepted
- **Date**: 2026-08-09 (proposed + accepted + implemented, migration 0084)
- **Closes**: the largest declared gap in the project — [ADR-0048](0048-agent-prompt-policy-versioning.md)
  deviation 1, recorded in [PENDING.md](../product/PENDING.md) §3 as *"the shadow canary for rules
  evaluates nothing"*.

## Context

ADR-0048 shipped immutable versioning, canary and one-click rollback, and wired it through the ONE
dispatch core for exactly one artifact type: `agent_system_prompt`. That half is genuinely live and
has been since migration 0060.

For the other four — `approval_rule`, `rate_limit`, `data_scope_rule`, `compliance_profile` — it
shipped the **substrate only**, and said so in its own amendment (deviation 1, in capitals):
versions could be created, activated, canaried, promoted and rolled back through the same admin
surface, while `governed-evaluate.ts` and `projects.ts:profilesForTags` went on reading
`approval_rules`, `rate_limits`, `data_scope_rules` and `compliance_profiles` directly.

Three consequences, all of them worse than they look:

1. **Activating a rule version changed nothing.** An admin could "activate v3" of an approval rule,
   see the status column flip, see an audit row, and be governed by v1 for ever.
2. **Rolling back a rule version changed nothing either** — the most dangerous of the three, because
   rollback is the gesture an operator reaches for *during an incident*.
3. **§2's shadow canary for restriction rules evaluated nothing at all.** ADR-0048 named this as
   the point of the shadow mode ("what would this rule have blocked?"), ADR-0059's blast-radius
   preview was specified to consume the signal, and the signal did not exist.

`canaryIsLive` named the boundary in code and the lineage endpoint disclosed it in prose, which is
why the gap was honest rather than hidden. It was still the single largest thing in the product
that looked built and was not.

## Decision

**The rule loaders resolve the ACTIVE version out of `config_versions` and overlay it onto the
loaded row. The CANDIDATE (canary) version is evaluated in parallel, never enforces, and every
sampled comparison is stored so an operator can see exactly which decisions would change before
promoting.**

Deliberately the **same shape as the prompt path**, not a second mechanism:

| prompt path (ADR-0048) | rule path (this ADR) |
|---|---|
| `resolveAgentPromptVersion` inside the one dispatch core | `applyRuleVersions` inside `governedEvaluate`, and `resolveRuleVersions` inside `profilesForTags` — the one funnel each |
| falls back to `agents.system_prompt` when no version rows exist | falls back to the rule's own table row when no version rows exist |
| `agents.system_prompt` is a read-model rewritten by `activateVersion` | the rule's table row is a read-model rewritten by the same `activateVersion` |
| the canary SERVES | the canary is EVALUATED IN PARALLEL and never serves |

### 1. Resolution, and where it happens

`governedEvaluate` already loads the three restriction-rule types through one scoped SQL pre-filter
each. After that load — and before the kernel is called — every loaded rule is resolved:

- **no version rows** → the table row governs. Byte-identical pre-ADR-0073 behaviour, which is what
  every existing install has.
- **an `active` version** → that version's body is overlaid onto the row. This is the clause that
  makes activation and rollback real.
- **version rows but NO `active` version** → **UNRESOLVABLE, and the call is DENIED** (see §4).

`profilesForTags` in `projects.ts` does the same for `compliance_profile`. It is the single funnel
every §8.3 cascade consumer already goes through — `projectPiiMode`, `projectMcpMode`, the ADR-0042
guardrail floor, the pillar-3 backup/patch floors — so all of them inherit the wiring without any of
them learning that `config_versions` exists.

### 2. What a rule version's body may contain — the scope line

A pillar-1 rule row has two kinds of column, and only one kind is versioned:

- **SELECTION** — `scope`, `serverScope`, `userId`, `roleId`, `teamId`, `serverId` (and a compliance
  profile's `tag`). These form the SQL predicate deciding *which rows are loaded for this caller at
  all*.
- **ENFORCING** — everything else. These decide what a loaded rule *does*.

**Only the enforcing columns are versionable.** Versioning a selection column would create a version
whose stored body claims the rule applies to somebody the pre-filter never loads it for — a rule
simultaneously "active" and unreachable, which is the most dangerous state a governance config can
be in. Rebinding a rule to a different subject is a **new rule**, not a new version of an old one,
and the API says so in a real 422 rather than storing a body it would then have to ignore.

Bodies are also **type-checked** before storage. A stored `{"windowSeconds": "sixty"}` would satisfy
`Record<string, unknown>`, activate cleanly, and then throw inside the rate limit's window
arithmetic on the **served** path — turning a bad edit into an outage instead of a refusal.

### 3. The shadow canary

`canary_pct` is honoured as a **shadow SAMPLING RATE** on the same deterministic `canaryBucket`
stable key ADR-0048 §2 already defines (here: the calling user, since a tool-call evaluation has no
run or conversation). Two consequences, both deliberate: the same caller is sampled consistently, so
a divergence report is a coherent picture rather than a scatter of unrelated single decisions; and
an operator can shadow 5% of a busy fleet without writing an observation row per call, or 100 — well,
99 — for the complete blast radius.

Each sampled evaluation runs the kernel a **second time**, parameterised by the candidate bodies and
**nothing else**, and writes one `config_canary_observations` row per participating artifact
carrying both sides' effect, ruleId and full reason. Divergence is judged on the **decision**, not
on the bodies: two different rule texts producing the same allow are not something an operator needs
to look at.

### 4. Default-deny survives version resolution

There is no path on which "I could not find the active version" ends in an allow.

An artifact with version rows and no `active` one has **no authoritative statement of what the rule
says**. Skipping a restriction is a *widening*, so:

- in `governedEvaluate` the call is **denied** with `ruleId: config-version-unresolvable` and the
  reason named;
- in the compliance cascade a `ConfigVersionUnresolvableError` propagates to a real **409
  `config_version_unresolvable`**, because dropping a compliance profile would relax `piiMode`,
  `mcpDefaultMode` and every floor it carries.

This state is unreachable through the API (`activateVersion` always leaves exactly one active, and
the lazy baseline in §5 mints one). It is reachable by a corrupt row, a hand-edited database or a
bad migration, and the kernel does not trust that it is not.

### 5. The lazy baseline instead of a migration backfill

Migration 0060 backfilled agent prompts. Rules were never backfilled, and this ADR does **not**
backfill them either: the first version an admin creates for a rule mints **v1 = the rule exactly as
it stands at that moment**, `active`, labelled `v1 (pre-versioning baseline)`, with its own
activation event and audit row; the requested body becomes v2.

Two reasons. A migration-time backfill would move every existing rule in every install onto the
version path in one step, for no behaviour change. And without a baseline, creating a first draft
would leave the artifact with version rows and no active version — i.e. §4's fail-closed branch
would fire on an admin's first ever edit, instead of being reserved for genuine corruption.

### 6. Performance — one query, not an N+1

Every artifact of every rule type needed by one evaluation is resolved in **ONE indexed query**
against `config_versions_artifact_status_idx`, keyed on the ids already in hand from the rule
pre-filter (`WHERE artifact_type IN (…) AND artifact_id IN (…)`). Not one query per rule, not one
per type. An install with rule rows but no rule versions pays exactly one extra query that returns
zero rows; an install with no matching rules pays none.

The shadow pass costs one extra in-process kernel call (pure, zero-I/O) per sampled decision, plus
one INSERT. A candidate whose `windowSeconds` or `toolName` differs from the active one costs one
extra count query — inheriting the active count would make a window change look like no change at
all. Unchanged windows reuse the count already computed.

### 7. `canaryIsLive` — what it means, and what this ADR does NOT do to it

The brief for this slice asked for `canaryIsLive` to become **true** for rules. It has not, and this
is the one place the implementation deliberately departs from its instructions.

`canaryIsLive` is read by `resolveVersion` and means **"does the canary SERVE traffic?"**. Flipping
it true for `approval_rule` would make the resolver serve the candidate — i.e. **enforce a candidate
`deny` on a percentage of real work**. That is the outage-with-a-percentage-sign ADR-0048 §2 exists
to forbid, and it directly contradicts this slice's own governing invariant that a shadow canary
must never affect the served decision. Flipping it would close the gap by breaking the thing the gap
was protecting.

What `canaryIsLive` was *also* being read as — "is this canary worth anything?" — was a second,
different question, and conflating them is why one flag could not tell the truth. So the vocabulary
is split into three explicit states, and the API reports all of them:

- `canaryIsLive(t)` — **serves traffic**. Unchanged, and **false for every restriction rule for
  ever**. A test pins it.
- `canaryIsEvaluated(t)` — **something genuinely computes what the candidate would have decided**.
  Now **true** for `approval_rule`, `rate_limit`, `data_scope_rule`, `compliance_profile` and
  `agent_system_prompt`.
- `canaryModeOf(t)` → `live | shadow | inert`, which is what the lineage endpoint, the audit prose
  and the SPA render.

`inert` exists because of the third case: ADR-0048 **declared** `agent_config` a live-canary type and
never wired a resolver, so for two waves `canaryIsLive('agent_config')` answered "yes" about
something nothing reads. `LIVE_CANARY_ARTIFACT_TYPES` is now explicitly a statement of *intent* and
`RESOLVED_ARTIFACT_TYPES` a statement of *fact*; `agent_config` is in the first and not the second,
and every surface says `inert` and "changes nothing and measures nothing".

## Consequences

- Activating and rolling back a rule version now **changes evaluation**, proved end to end through
  the kernel rather than by reading a status column.
- An operator can answer *"what changes if I promote this?"* from stored evidence — per decision,
  with both reasons in full — instead of from a diff of two rule bodies and a guess.
- `config_canary_observations` grows at **one row per sampled governed tool call** while a rule
  canary is running. `canary_pct` is the dial, and there is **no pruning** (the same disclosure
  ADR-0048 already carries for `config_versions`).
- Every rule table gains a second writer (`activateVersion`, as a read-model). Dispatch never trusts
  it, so a drift between the row and the active version would be a display bug, not a governance
  bug.
- ADR-0059's blast-radius preview now has the shadow signal it was specified to consume. Consuming
  it is not in this slice.

## What is GENUINELY ENFORCED vs. what is STRUCTURAL ONLY

**Genuinely enforced** (`apps/gateway/src/rule-versioning.test.ts`, 25 cases, and the pure half in
`packages/shared/src/config-versions.test.ts`):

- **THE SHADOW CANNOT TOUCH THE SERVED DECISION.** The *entire* decision object — effect, ruleId,
  ruleChain, reason, approver — is captured before any candidate exists and asserted **deep-equal**
  after a candidate that would pause the call is running at a real sampling percentage. A candidate
  that leaked one field into the answer fails.
- **AND IT NEVERTHELESS MEASURES SOMETHING.** The same run asserts a divergence row exists naming
  `served: allow` / `candidate: require_approval`, with the candidate's full reason, the sampling
  rate and the bucket. A canary that recorded nothing passes the first assertion and fails this one;
  a canary that enforced passes this one and fails the first. Both are required together.
- **A CANDIDATE THAT THROWS IS SAFE AND LOUD.** A corrupt candidate body is written straight into
  `config_versions` (bypassing the API's type check — the exact case the try/catch exists for), the
  served decision is asserted byte-identical to the reference answer, and a `failed` observation is
  recorded carrying `RangeError: Invalid time value`. A failure is explicitly **not** counted as a
  divergence, and the report's own note refuses to let `diverged` be read as complete while
  `failed > 0`.
- **PROMOTION CHANGES EVALUATION; ROLLBACK RESTORES IT.** Promote → the very next evaluation is
  `require_approval`; roll back → the next one is `allow` again, v2's row still exists with its body
  intact at status `rolled_back`, and the rule's own row follows both ways.
- **DEFAULT-DENY SURVIVES.** With the active version forced to `superseded`, the evaluation returns
  `deny` / `config-version-unresolvable` with the reason stated, and the compliance cascade returns
  a real **409** rather than dropping the framework.
- **THE LAZY BASELINE IS REAL.** The first version creates v1 `active` whose body is asserted equal
  to the rule as it stood, and the requested body lands as v2 `draft` changing nothing until it is
  activated.
- **THE AUTHORING SURFACE REFUSES HONESTLY.** A selection field → 422 naming what to do instead; a
  wrongly-typed field → 422 before it can reach the served path; a version of a rule that does not
  exist → 404; every route still 403 to a non-admin.
- **THE DISCLOSURE MATCHES REALITY.** `canaryIsLive: false`, `canaryIsEvaluated: true`,
  `canaryMode: shadow` for rules; `inert` for `agent_config`; and the endpoint no longer contains
  the string `NOT yet wired`. ADR-0048's own test asserting that string was **rewritten, not
  deleted**, with a comment naming what changed and why.
- **THE OPERATOR SURFACE IS DRIVEN IN A REAL BROWSER.** `apps/web/e2e/phase7-rule-shadow-canary.spec.ts`
  (Playwright **82 → 86**, zero console errors): the invariant is asserted on the rendered page, a
  candidate that would DENY is set up through the API, the served decision is asserted **unchanged as
  the whole object**, and the divergence — including the sentence the caller would have been given —
  is read off the screen. The spec mints a fresh rule id until the subject falls inside the 99%
  sample rather than asserting on a decision that was correctly not sampled, and the candidate
  produces a DENY so the divergence is unambiguous against the seeded fleet rules.
- **SAMPLING IS STICKY AND BOUNDED.** The pure suite asserts the same key lands on the same side six
  times running, that ~1% is sampled at pct 1 and ~99% at pct 99, and that a key outside the sample
  is reported as `candidateSampledOut` so a zero count is distinguishable from "no canary".

## Disclosed rather than closed

1. **`agent_config` is still vocabulary only.** Nothing resolves it at dispatch and nothing shadows
   it. It is the remaining half of ADR-0048's deviations 1/2 and is reported as `inert` everywhere.
2. **A rule canary still never serves, by design.** There is no gradual enforcement ramp for a
   restriction rule and there will not be one. If you want the candidate enforced, promote it.
3. **`canary_pct` is capped at 99 by ADR-0048's DB CHECK**, so at maximum sampling ~1% of stable
   keys are never shadowed. Not fixed here: relaxing the CHECK would change an accepted ADR's
   constraint from inside a different slice.
4. **The shadow pass is INLINE and awaited.** It adds one pure kernel call, one INSERT, and (only
   when the candidate moves a limit's window or tool) one count query to a sampled request. It is
   not deferred to a queue, because a fire-and-forget measurement is one whose failures nobody sees.
5. **No pruning.** `config_canary_observations` grows monotonically while a canary runs, exactly as
   `config_versions` does. The retention tie to the §8.3 cascade that ADR-0048 deferred is still
   deferred, and now covers one more table.
6. **The compliance-profile shadow is computed at READ time, not per call.** A profile candidate's
   effect is a pure function of the profile bodies and a project's tags — it does not vary per
   request — so writing one observation row per call would store the same answer N times. The
   divergence report computes it live over the first **50** projects carrying the tag and labels
   itself `NOT sampled and NOT stored`. A 51st project is not shown.
7. **`compliance_profile` divergence is not recorded historically at all.** There is no stored
   evidence of what a profile candidate would have done last Tuesday, only what it would do now.
8. **The rule canary's divergence is not fed to ADR-0059's blast-radius preview.** The signal now
   exists; the consumer was not wired in this slice.
9. **Selection fields are not versionable and rebinding a rule is a new rule.** An org that expects
   "move this rule from Dana to the Platform team, versioned" gets a 422, not a version.
10. **The read-model has two writers.** `activateVersion` and the ordinary rule-CRUD routes both
    write the rule table. Editing a rule through `POST /v1/rules/approvals`-style CRUD does **not**
    mint a version (unlike `POST /v1/agents/:id/system-prompt`, which does) — so a versioned rule
    edited through the old CRUD surface would have its row and its active version disagree, and
    **dispatch would keep serving the version**. Named rather than fixed: converting the rule CRUD
    routes into version-minting routes is its own slice with its own regression surface.
11. **Promotion for rule types is gated exactly as ADR-0048 left it** — an ADR-0044 eval run is the
    gate, and since eval runs measure agents rather than rules, in practice every rule promotion is
    the audited `canary-promote-override` path with a reason. That is honest, not a hard quality
    bar.
12. **Nothing here is proven against a real model provider**, which remains true of the whole
    product (PENDING §1 P1). It does not bear on this slice: the rules engine is deterministic and
    provider-independent.

---

## Amendment — 2026-08-09: gap 10 is closed, and its description above was imprecise

*This section is appended. Nothing above it has been edited; the Accepted decision stands unchanged,
and this records only that one of its stated gaps has been closed — and corrects how that gap was
described. See [ADR-0074](0074-rule-read-model-write-choke-point.md).*

### The correction

Disclosure 10 says a versioned rule *"edited through the old CRUD surface"* would have its row and
its active version disagree. That sentence implies a body-edit CRUD route exists. **It does not.**
There has never been a `PUT`/`PATCH` route that edits `toolName`, `maxCalls`, `windowSeconds`,
`argPath`, `allowedValues`, `writeOnly` or `approverUserId`. `POST /v1/rules/approvals`,
`/v1/rules/data-scopes` and `/v1/rules/rate-limits` are **pure creates** — no `ON CONFLICT`, a
`defaultRandom()` id, and no unique constraint an upsert could target — so a row they write cannot
have a `config_versions` row at the instant it is written, `resolveForShadow` returns `served: null`,
and the raw row is served. They were never the defect.

**The actual defect was narrower in surface and worse in kind.** Exactly three routes wrote a
VERSIONED column without minting a version, and all three were live:

1. **`PATCH /v1/rules/:kind/:ruleId/deploy-mode`** (`org-settings.ts`). `deployMode` is a versioned
   field for all three restriction types. The handler did a bare
   `db.update(table).set({ deployMode })` through a module-local table map — which is why a
   `.update(approvalRules)` grep never found it — wrote a confident audit row claiming the scope
   changed, and returned 200 with the updated row. One click on the rules list in the admin portal.
2. **`POST /v1/compliance/profiles`** (`projects.ts`). Not a create route: an
   `onConflictDoUpdate` on the UNIQUE `tag`, i.e. **the only edit path a compliance profile has**.
   Every field it rewrote except `tag` is versioned, and `profilesForTags` resolves profiles through
   `config_versions` — so tightening `piiMode` on a versioned framework profile returned 201, showed
   the new value everywhere, and changed nothing about PII handling, MCP data-scope defaults,
   retention, budget ceilings, guardrail floors or red-team gating.
3. **`POST /v1/onboarding/compliance-pack`** (`onboarding.ts`). The same upsert. It computes
   `plan.profile: "update" | "create"` in its own dry-run, so it knew it was overwriting.

The disclosure was also incomplete in a second way: it framed the outcome as "dispatch keeps serving
the version", which is true only when the active body NAMES the field. `RULE_BODY_SCHEMAS` make
every field optional, so a hand-authored partial body that omits `deployMode` falls through to the
row and the write **does** take effect. Auto-baselined artifacts are never partial (`ruleBodyFrom`
copies every field with `?? null`), so in practice most installs got the vanishing case — but an
admin could not tell which one they got from the 200 response. Both outcomes are wrong.

### What is now true

ADR-0074 routes all three through one choke point (`applyRuleEdit`), which classifies the patch by
field class and mints + activates a version when — and only when — a versioned artifact's enforcing
field actually moves. `rule-write-guard.test.ts` enumerates every `.insert`/`.update` against the
four tables, including writes through a variable, and fails when an un-audited one appears.
`rule-write-versioning.test.ts` asserts the fix **through a real governed decision**, which is the
assertion that was missing and is why the defect shipped: a test that checked the row or the version
count would have passed against the broken code.

ADR-0074 also closed one thing this ADR did not name at all: `activateVersion` wrote both read-models
(`agents.systemPrompt` and the rule row) **after** its transaction committed, so a crash in that
window reproduced the same divergence with no bad writer involved. Both writes now run inside the
transaction.

**Still not closed by this amendment**: disclosures 1–9, 11 and 12 stand exactly as written. In
particular `agent_config` is still vocabulary only, a rule canary still never serves, there is still
no pruning, the compliance-profile shadow is still computed at read time over the first 50 projects
and never stored historically, and the divergence signal is still not fed to ADR-0059's
blast-radius preview.
