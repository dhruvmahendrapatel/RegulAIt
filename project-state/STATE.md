---
phase: feature-review-wave-closed-and-market-queue-building
last_updated: 2026-08-13
active_epics: []
completed_epics: [EPIC-01, EPIC-02, EPIC-03, EPIC-04, EPIC-05, EPIC-06]
open_questions_open: []
last_session: sessions/2026-08-13-session-15.md
roadmap: ../docs/product/ROADMAP.md
---

# RegulAIt — Project State

> **Maintenance note (2026-07-31): this file was allowed to drift and has been caught up.**
> Between PR #57 and PR #75 — roughly eighteen PRs including the entire React SPA rewrite and the
> whole authentication system — updates went into the session log
> (`sessions/2026-07-30-session-03.md`) but NOT into this file, which `CLAUDE.md` names as one of
> only two artifacts guaranteed to persist across sessions. The recap below is now current as of
> PR #75. **Lesson for future sessions: update STATE.md at the same moment as the session log, not
> at the end of a long batch** — a session that ended unexpectedly during that window would have
> handed its successor a file describing a project with "no workload to deploy".

## Where we are (read this paragraph first)

**2026-08-20 — the Credo-gap queue is landing: L1 and L3 shipped, positioning refreshed.** A
gap analysis against Credo AI ([GAP_ANALYSIS_CREDO_AI_2026-08.md](../docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md))
ranked eight lacks, and the owner directed both building the gaps and out-placing their
presentation — so [POSITIONING.md](../docs/product/POSITIONING.md) (category claim: *AI governance
that enforces itself*), two ADR-cited comparison pages, and a README hero rewrite shipped first.
Then **L3**: a seventh seed compliance pack — SOC 2 Security (Common Criteria), 10 controls
honestly graded, no CPA review claimed, `cascadeTag` null — as a dated ADR-0058 amendment. Then
**L1** ([ADR-0080](../docs/decisions/0080-ai-use-case-registry.md)): an AI use-case registry with
a pre-build intake front-door on pillar-2 rails (gallery template → ADR-0079 resting plan →
questionnaire artifact → sign-off), whose `complianceTags` are the same tags §8.3 enforces and
whose status can only change through the one decide path (both lifecycle joins proven non-vacuous
the M-002 way), plus an admin Use-cases page. Then **L2**
([ADR-0081](../docs/decisions/0081-ai-risk-register.md)): an AI risk register that makes the
measurements legible as *risk* — a `DEFAULT_RISK_LIBRARY` of eight agentic risks whose evidence
is computed at read time through a fixed category→resolver mapping over the real ledgers
(red-team ASR verbatim with its Wilson interval, groundedness runs, PII/budget denials,
guardrail configs, grants inventory), measured and declared kept in two labelled blocks that
are never blended, acceptance an admin-only audited terminal action that freezes the evidence
it was taken on, and `scope_drift` honestly attestation-only. Then **L7+L8**
([ADR-0082](../docs/decisions/0082-inventory-and-posture.md)): a standing agent dependency
inventory — pure aggregation, no migration — where **granted (may) and observed (did) are
never blended** (grants ∪ role-derived − revocations vs. usage-event dispatches, trace-attributed
tool/connector calls, and agent→agent feed edges from orchestration run history), plus a
board-shaped, print-friendly **Posture one-pager** on ADR-0047's rails: every number a SELECT
at request time (pack coverage via `evaluatePack`, risk counts with the attestation-only count
named, ASR verbatim with its Wilson interval, spend vs budget, observed anchor grading), and
an empty section renders *unmeasured, not resisted* — never zero-implies-good. Gateway suite
**2172 passing + 9 MinIO skips / 131 files**, Playwright **109/109**, on fresh scratch
databases — still the only gate (Actions exhausted). Then **L4**
([ADR-0083](../docs/decisions/0083-shadow-ai-first-party-discovery.md)): first-party shadow-AI
discovery as an **extension of ADR-0071, not a reversal** — a frozen, hash-pinned
`SHADOW_AI_CATALOG_V1` (81 entries: 37 endpoint, 44 SDK signatures; no regex over input, no
scrapers, no network calls) classifying operator-supplied DNS/proxy logs and dependency
manifests through ADR-0071's existing ingest path, with the honest core being the
**governed-via-gateway vs shadow** line computed per request from live model-credential/custom-
provider config (deliberately NOT the egress allow-list, which would launder egress permissions
into "governed AI"); a hit proves an artifact mentioned a provider, never that traffic flowed,
and compiled-only signature hits surface as named catalogue gaps rather than findings. Gateway
suite **2183 passing + 9 MinIO skips / 132 files**, Playwright **110/110**. Next: **L5
vendor-risk portal** (owner-directed 2026-08-20, overriding the gap doc's defer note); L6
(governance copilot) stays blocked on the parked model credential. Process note: M-019 logged —
a REPEAT of M-014 (agent parked on a watcher despite the rule in its brief); the rule is
rewritten to make parking impossible (foreground suite runs with explicit timeouts, stated
inside the verification step).

**2026-08-15 — the ten-slice feature review is CLOSED and the market-analysis build queue is
under way.** Every pillar was driven end-to-end and attacked with probes written to fail if
enforcement regressed. Four governance holes were found live and closed (inert server grant;
the semantic cache as a PII bypass; the self-review guard not surviving a delegation; the
deploy-override with no second party), one ledger-honesty defect fixed (a refused dispatch
claiming pillar-6 savings), and pillar 7's inheritance attacked and found genuinely holding.
Local WORM anchoring (MinIO Object Lock, COMPLIANCE, observed grading) ships in compose by
default; the deployment-wide PII floor closed the attribution dodge; `mistakes.md` is now an
owner-mandated bootstrap read. A fresh market analysis
([MARKET_ANALYSIS_2026-08.md](../docs/product/MARKET_ANALYSIS_2026-08.md)) found the gateway
category absorbed by security vendors and named the **compliance cascade as the single most
defensible claim** — so three queue items shipped against it: the P5 cost-reconciliation +
roster wedge (ADR-0076), the cascade as the demo's headline path plus a cascade-derived
template gallery (ADR-0077), and the tighten-only delegation conformance contract (ADR-0078).
Gateway suite **2108 passing / 126 files**; GitHub Actions are exhausted, so internal
validation on fresh scratch databases is the gate. The queue's top two items (a live model
provider, live-instrument verification) are blocked on credentials the owner keeps parked.

**ADR-0075 shipped, 2026-08-13 — [the regulAIt brand package and the regulAIt UI Structures contract are adopted in the SPA](../docs/decisions/0075-brand-identity-and-ui-structure-adoption.md).
NO MIGRATION — this is presentation only; no schema, no API, no governance semantics.** The owner
supplied two standards, and they settle their own precedence: *"the brand package wins on colour,
type and the mark. This document wins on structure and markup contracts."* A third artefact in the
same archive — an **"Organic" design system** (cream, terracotta, Caprasimo) — is **not adopted**,
and the evidence is decisive rather than a judgement call: it is a generic design-system export with
its own `theme.json` and no product, while UI Structures is titled *"UI structures for regulAIt
apps"*, points at the brand package by name, and is itself rendered in Gantari/Figtree/IBM Plex Mono
over Graphite and Signal Cyan. The two regulAIt artefacts agree; Organic disagrees with both.
`apps/web/src/theme/tokens.css` is rewritten around the `--rg-*` token **names** the contract
specifies (*"Names are the API"*) with **values** from the brand: the twelve-step Graphite ramp,
Signal Cyan 500/400/700, the four product accents, and the four-step severity scale with AA-passing
`-deep` text steps. **The whole palette swapped from one file with zero component edits**, because a
survey found **zero hardcoded hex outside `src/theme/`** — the SPA's pre-existing token discipline
is what made this cheap, and the original names remain as one-directional aliases. Gantari, Figtree
and IBM Plex Mono are **self-hosted** (~90KB; both display faces are variable, so one woff2 each) —
a brand rule that is also an ADR-0062 air-gap requirement, since an off-origin font request would
break air-gapped mode. The sidebar becomes the app's only dark surface and does not invert with the
theme; the mark's AI node is pinned to Signal Cyan; and the brand's forbidden spellings are
corrected in user-visible copy — the wordmark is **`regulAIt`**, and the app had been shipping
"RegulAIt" on every screen. UI Structures' **seven accessibility invariants are now asserted in a
real browser** (`apps/web/e2e/brand-contract.spec.ts`): `main#rgMain` must resolve to a non-zero
box, and the skip link must genuinely be the first tab stop under a real Tab press. That choice is
the point — the doc's own Traps section records a page that returned **200 while rendering its full
markup into a zero-height container**, which any stylesheet assertion would have passed.

**Two process lessons from writing that spec, both worth keeping.** First, **a priming click
invalidates a focus test**: clicking before pressing Tab sets the document's *sequential focus
navigation starting point*, so Tab resumed past the sidebar and the correct skip link "failed" — and
the first fix attempted was a CSS change to markup that was never broken. Second, **a green contract
can be green for the wrong reason**: the wordmark check passed on its first run because the route
list did not cover the pages carrying the offending copy *and* a word-boundary regex let
"RegulAIt-LLM" through on a trailing hyphen. Tightening both made it fail on 14 of 15 routes. That
is the same lesson as ADR-0072's three scoring inversions — *check that the test can fail.*

### Previously


**ADR-0074 shipped, 2026-08-09 — [an ordinary admin edit of a versioned rule now changes what is ENFORCED, not only what is DISPLAYED](../docs/decisions/0074-rule-read-model-write-choke-point.md).
NO MIGRATION — every column already existed.** ADR-0073 (below) made the ACTIVE `config_versions`
row the thing that enforces, which demoted the four rule tables to a **read-model**. Its own gap 10
named the consequence and left it open: any writer that mutated a VERSIONED column without minting a
version produced **silent divergence** — the admin saw their edit in the row, in `GET /v1/rules/*`
and in the SPA, and enforcement never moved. **In a governance product that is worse than a
refusal.** Gap 10 also described the defect wrongly, and the amendment on ADR-0073 corrects it: it
said a rule *"edited through the old CRUD surface"*, implying a body-edit route that **has never
existed**. The three `POST /v1/rules/*` routes are pure creates and were never the defect. The real
set was: **`PATCH /v1/rules/:kind/:id/deploy-mode`** — a bare update **through a module-local table
map**, so a `.update(approvalRules)` grep never found it, and one click on the admin rules list;
**`POST /v1/compliance/profiles`**, which is **not a create route** but an `onConflictDoUpdate` on
the UNIQUE `tag`, i.e. the ONLY edit path a compliance profile has, silently under-enforcing PII
mode, MCP defaults, retention, budget ceilings, ADR-0042 guardrail floors and ADR-0068 red-team
gating **at once**; and **`POST /v1/onboarding/compliance-pack`**, the same upsert, which computes
`plan.profile: "update"` in its own dry-run and therefore *knew* it was overwriting. Worse, the
outcome was **non-uniform** — `RULE_BODY_SCHEMAS` make every field optional, so against a partial
active body the write *did* take effect, and the same 200 meant "discarded" on one artifact and
"applied" on another with no way to tell. **The fix is one choke point, not three patches**:
`applyRuleEdit` classifies the patch by field class — selection-only or unversioned artifact → plain
row write (ADR-0073 §2 and invariant 4, byte-identical pre-0073); effective no-op → **mint nothing**
(the onboarding pack is *designed* to be re-run); enforcing change on a versioned artifact → **mint
AND activate**; versions present with none active → **409 refusing the write**, naming the activate
route, because default-deny extends to WRITES. **The load-bearing line**: the body is composed onto
the **ACTIVE BODY**, never onto the row — the row may already be drifted, and minting from it would
promote that drift into an enforcing version, i.e. the fix would ratify the bug. Atomicity is
**structural**: the mint branch never writes the enforcing columns itself, it lets
`activateVersion`'s `writeRuleReadModel` do it — and that write **moved inside the transaction**,
closing a crash window that reproduced the same divergence with no bad writer involved (this also
reorders ADR-0048's agent-prompt read-model write). **Auto-activation bypasses no gate**, answerable
from code: `evaluatePromotion` gates promoting a CANARY; direct activation has never been gated and
`newVersion(activate:true)` is the shipped pattern. **The structural guard, because a point fix does
not close a class**: `rule-write-guard.test.ts` enumerates every drizzle `.insert`/`.update` in every
gateway source — **including writes through a variable**, which is how the worst writer hid — pins
the set against an audited list where every entry states why it is safe, refuses aliased imports and
raw SQL, and pins that only two modules may import `newVersion`. Verified by attack: adding a bare
`db.update(complianceProfiles)` to an unrelated file makes it red. **Because an ordinary edit can now
move a shadow canary's baseline**, ADR-0072's posture is applied to the comparison — a live ADR-0073
read defect fixed on the way: both surfaces aggregated on `candidate_version_id` **alone** while
`active_version_id` was already stored, pooling comparisons against different baselines into one
`diverged` count that fed a promotion decision. Now every aggregate is keyed on **(candidate,
active)**, the stranded set is **reported beside the totals and never folded in**, the ledger records
`the shadow comparison baseline moved here`, and `POST …/promote` **refuses** a mixed-baseline sample
(`canary-promote-stale-baseline`) unless overridden with a reason — **the gate lands on the
PROMOTION, never on the EDIT**, so an incident edit is never blocked by a measurement. A NULL
baseline counts as NOT comparable, because that failure direction matters. Orphaned versions
(`artifact_id` is polymorphic so there is no FK; deleting a user, server, role, team or **approver**
cascades the rule away and leaves an `active` version behind) are now **disclosed** by both read
surfaces instead of rendering as a live governed artifact — deliberately **not** deleted, since they
are the record of what governed the calls made while the rule existed. **Every assertion is a
governed DECISION, never a column** — a test reading the row or the version count would have passed
against the broken code, which is exactly why the defect shipped; with the fix disabled **12 of the
15 new cases fail**. **Verification**: gateway **1,968 → 1,989 tests / 113 → 115 files** on a freshly
created DB with **no existing gateway test rewritten**; shared **579 → 593**; Playwright **86 → 88**,
zero console errors; policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58,
workflow-kernel 39, orchestration-kernel 27, optimizer-kernel 69, pm-provider 62, git-provider 51,
connector-provider 58 all unchanged; `pnpm -r build`, `pnpm -r typecheck`, `pnpm --filter
@regulait/web build` clean. **Disclosed rather than closed** (eleven items in the ADR): **operational
bypasses remain** — a manual `psql`, a `pg_restore` of a pre-versioning backup or an air-gapped
database dump all desynchronise a row with no application code involved, and **nothing in the schema
prevents it**; existing drift is corrected **opportunistically on the next edit**, with no backfill
and **no drift report** naming currently-drifted artifacts; partial version bodies are still
authorable; ADR-0073's **read-side asymmetry stands** — `redteam.ts`, `cost-import.ts`,
`compliance-packs.ts` and `setup-status.ts` read compliance profiles RAW and so fail **OPEN** in the
same state the cascade fails closed; orphans are disclosed, **not tombstoned** (the AFTER DELETE
trigger is its own slice); and the guard is a source scan over the gateway's own sources only.

**ADR-0073 shipped, 2026-08-09 — [the rules engine now reads `config_versions`](../docs/decisions/0073-rules-engine-versioning.md)
(migration 0084). This closes the LONGEST-STANDING DECLARED GAP in the project**, `PENDING.md` §3's
ADR-0048 row: *"the shadow canary for rules evaluates nothing"*. ADR-0048 shipped immutable
versioning/canary/rollback and wired ONE artifact type (`agent_system_prompt`) through the dispatch
core; for `approval_rule`, `rate_limit`, `data_scope_rule` and `compliance_profile` it shipped
**storage only**, and said so in capitals. So activating a rule version changed nothing, **rolling one
back changed nothing** — the gesture an operator reaches for during an incident — and §2's shadow
canary evaluated nothing at all. Now `governedEvaluate` overlays the **ACTIVE** version of every
loaded rule onto its row before the kernel is called, and `projects.ts:profilesForTags` — the ONE
funnel every §8.3 cascade consumer already goes through — does the same for compliance profiles, so
`projectPiiMode`, `projectMcpMode`, the ADR-0042 guardrail floor and the pillar-3 infra floors all
inherit it without learning `config_versions` exists. **Deliberately the same shape as the prompt
path, not a second mechanism**: fall back to the table row when no version rows exist
(byte-identical pre-0073 behaviour), the table row becomes a read-model rewritten by the same
`activateVersion`, and dispatch never trusts it. **The shadow canary genuinely evaluates**: the
served decision is computed to completion FIRST from the active bodies alone, then the candidate runs
through the SAME kernel call parameterised by the candidate bodies **and nothing else**, and both
sides' effect/ruleId/full reason land in `config_canary_observations` — deliberately NOT `audit_log`,
which since ADR-0060 is the hash-chained record of decisions that were SERVED. `canary_pct` is
honoured as a shadow **SAMPLING RATE** on ADR-0048's existing deterministic bucket. **Proved
adversarially in both directions at once**: the ENTIRE served decision object is captured before any
candidate exists and asserted **deep-equal** while a candidate that would PAUSE the call is running,
AND the same run asserts a divergence row naming `allow` vs `require_approval` — a canary that
recorded nothing passes the first and fails the second, one that enforced passes the second and fails
the first. A corrupt candidate written straight into `config_versions` **throws**, the served answer
is byte-identical, and the failure is recorded as `failed` (never as a divergence). Promotion then
genuinely changes the served decision and **rollback restores it end to end**. **Default-deny
survives**: version rows with NO active version are UNRESOLVABLE and DENY
(`config-version-unresolvable`), or a real **409** in the compliance path. Resolution is **ONE
indexed query per evaluation** across all three rule types, not an N+1; ADR-0048 §7's baseline is
applied **lazily** (the first version of a rule mints `v1 (pre-versioning baseline)` from the live
row) rather than by migration backfill. Only **ENFORCING** columns are versionable — a body naming a
SELECTION column (`userId`, `serverId`, `scope`, `tag`) is a real **422** naming what to do instead,
and bodies are **type-checked** so a stored `windowSeconds: "sixty"` cannot activate and then throw
on the SERVED path. **`canaryIsLive` was NOT flipped for rules, deliberately, and this is the one
place the slice brief was not followed**: it is read by `resolveVersion` and means "the canary
SERVES", so flipping it would enforce a candidate deny on a share of real work — the exact outage §2
forbids, and a direct contradiction of the same brief's own invariant. The vocabulary is split
instead: `canaryIsLive` (still false for rules, pinned by a test), `canaryIsEvaluated` (now true for
all four rule types) and `canaryModeOf` → `live | shadow | inert`; `inert` exists because ADR-0048
DECLARED `agent_config` a live-canary type and never wired a resolver, so the API had been answering
"live" about something nothing reads. **The SPA surfaces it**: `/admin/governance/rules` gained a
shadow-canary card listing every running canary with sampled/would-change/failed counts and, per
decision, what was served versus what the candidate would have done including the sentence the caller
would have been given. **Verification**: gateway **1,943 → 1,968 tests / 112 → 113 files** on a
freshly created DB; shared **566 → 579**; the full Playwright suite **82 → 86**, all green with zero console errors; policy-kernel 129, model-provider 122, infra-provider 174,
training-provider 58, workflow-kernel 39, orchestration-kernel 27, pm-provider 62, git-provider 51 all
unchanged; `pnpm -r build`, `pnpm -r typecheck` and `pnpm --filter @regulait/web build` clean.
ADR-0048's test asserting the endpoint said "NOT yet wired" was **REWRITTEN, not deleted**, with a
comment naming what changed. **Disclosed rather than closed** (twelve items in the ADR): **`agent_config`
is still vocabulary-only** and now reports `inert` instead of being mislabelled `live`; the **ordinary
rule-CRUD routes do NOT mint a version**, so a versioned rule edited through the old CRUD surface has
its row and its active version disagree and **dispatch keeps serving the version** — the sharpest
one; a rule canary still never serves, by design; `canary_pct` is capped at 99 by ADR-0048's DB CHECK
so ~1% of keys are never shadowed; the shadow pass is **inline and awaited**; **no pruning** — one
more monotonically-growing table; the **compliance-profile shadow is computed at READ time over the
first 50 tagged projects** (its effect does not vary per request) and is **never stored
historically**; the divergence is **not fed to ADR-0059's blast-radius preview**; and rebinding a
rule to a different subject is a new rule, not a new version.

**The three API-only parity features got a user-facing surface, 2026-08-09 — NO new ADR and NO
migration, deliberately.** The owner's second request was competitor parity and *"maybe we will
release this as a freeware"*. Six parity ADRs shipped, but **three of them disclosed "there is no
SPA page"** — and on a freeware tool a feature nobody can reach without `curl` is, from a user's
point of view, not built. This slice is a UI layer over already-accepted decisions, so it amends
those ADRs with **dated, appended amendments** rather than superseding them; the Accepted text of
0066, 0069, 0071 and 0072 is untouched. **Three pages**: `/admin/virtual-keys` (ADR-0066, nav
*Identity & Access*) issues a key showing the plaintext **exactly once**, never fetches it again,
leads with the ceiling rule (*a key only ever NARROWS* — listing a model does not grant it), and
renders the enforcement counter and the `usage_events` total **apart** so a disagreement would be
visible; `/admin/cost-consolidation` (ADR-0069, nav *Cost*) uploads/pastes an export, prints each
adapter's `limits` **verbatim from the registry**, dry-runs with **rows accepted vs refused and
every refusal's file line number**, applies, and carries the identity-mapping surface and the
consolidated per-person/per-cost-centre view; the shadow-AI page (ADR-0071) gained a **raw-file
import** card printing each adapter's `verification` sentence **verbatim** — including the four
that say outright they have **never been run against a real vendor export** — with the
whole-file-refusal default and its opt-out labelled as an opt-out. **The ADR-0069 honesty rule
survived into the layout, which is the point**: `metered` and `imported` render in two
separately-ruled columns and are **never summed**, and the browser spec **computes** each
subject's `metered + imported` from the API's own answer and asserts that number appears nowhere
in the document — so the guarantee cannot quietly stop being tested if seeded spend moves.
ADR-0072's stranded-baseline report is now a card on `/admin/evals` (versions, per-version run
counts labelled comparable/NOT, and every stranded pin by run id with the action); ADR-0067's four
groundedness scorers and its `eval_cases.context` field were **already** authorable and needed no
work — verified in the browser rather than assumed. **Two real bugs were found only by driving a
browser, and both are fixed**: (1) `apps/web/src/api/client.ts` called `.join()` on an
`issues[].path` the gateway had already joined into a **string**, so the TypeError escaped from the
`ApiError` constructor and **every such refusal rendered as a JavaScript error instead of its
reason** — the exact failure the "honest refusals" rule exists to prevent; (2) `RequireAdmin`
**silently bounced** a non-admin to Home, which is a disappearance rather than a refusal — it now
renders a real "you don't have access" statement, with the gateway still refusing independently.
Two CSS classes referenced by ~15 admin screens (`.statRow`, `.grid`) were **never defined**, so
those stat rows had no layout at all; both are now defined once. **Verification**: gateway
**1,943 / 112 files unchanged** (no gateway source touched), shared 566, policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 — all unchanged; `pnpm -r build`,
`pnpm -r typecheck` and `pnpm --filter @regulait/web build` clean; the **full Playwright suite is
63 → 82 tests**, all green, with zero console errors and 19 screenshots. **Disclosed rather than
closed**: ADR-0066's **fallback chains still have no page**; adapter configuration is a raw JSON
textarea rather than a per-adapter form builder; the cost page has no bulk cost-centre editor; and
the *adapters have still never met a real vendor export* — the page makes that visible, it does not
make it untrue.

**ADR-0072 shipped, 2026-08-07 — [the two scoring inversions, fixed together with an explicit
baseline reset](../docs/decisions/0072-scoring-semantics-correction.md) (migration 0083, the number
ADR-0071 deliberately left unused).** This is a CORRECTION slice, not a feature slice, and it amends
two **Accepted** ADRs with the owner's explicit approval. Both bugs were the same shape: **the
system recorded an ABSENCE OF MEASUREMENT, or a SUCCESS OF THE DEFENCE, as a bad number** — which
then flowed into an average, a drift comparison, a promotion gate and a compliance artifact.
**(1) ADR-0044 scored an `llm_as_judge` case with NO judge as 0** (`no_judge_configured`). Loud,
which is exactly why ADR-0067 left it alone — but wrong IN KIND: a **missing instrument** recorded
as a **bad measurement**, averaged into `mean_score`, deltaed against a baseline, read by the gate
as "the agent answered badly", and citable as measured evidence by an ADR-0045 model card. It now
takes ADR-0067's posture **exactly** — a real **422** from `judgeAvailabilityFor` placed **before**
the `eval_runs` INSERT, with the suite asserting **no run row, no result row and not one dispatched
token** — and the old score-0 branch is an unreachable **throw**, deliberately not a fallback,
because a fallback to zero is the very thing being removed. **(2) ADR-0057 scored a
guardrail-BLOCKED probe as a DEFEAT**, so **the platform holding looked identical to the platform
failing** — in the per-probe outcome, the class aggregate, the pooled ASR and the gate. ADR-0068
found it, named it on the per-trial row, counted `platform_held`, and declined to fix it because it
would move every stored baseline — while **its own sequence path already scored the same input
correctly**. Both paths now call **one** `classifyDispatchFailure`: a governance stop is a
**platform hold** (resisted, score 1, counted, never an attack success anywhere including the
aggregate ASR); a transport failure is excluded from the ASR **denominator**. The new suite runs
**the same probe text down BOTH paths** against the same agent under the same blocking guardrail and
asserts they agree field by field — an assertion that would have FAILED before this slice.
**The baseline reset is the part that makes this safe, and it is explicit.** Both fixes change what
stored numbers MEAN without changing their SHAPE, which is the most dangerous kind of change a
measurement system can make. Migration 0083 adds `scoring_semantics` to `eval_runs` and
`redteam_runs`; every pre-existing row is stamped **1** by the column DEFAULT and everything after
**2**. **History is MARKED, never rewritten and never deleted**, and `audit_log` is not touched at
all, so ADR-0060's hash chain is unaffected *by construction* rather than by care. Comparison
refuses in **four** places: auto-resolution filters on the column; an explicitly pinned pre-0072
baseline is a **422 before the run row exists**; an admin-pinned stranded baseline **FAILS the gate
and names the run to re-pin** (never silently swapped for another); and pinning a v1 run is refused
with **409 `baseline_semantics_stale`**. Both gates gained `baselineComparable` +
`baselineIncomparableReason`, because `scoreDelta: null` alone cannot distinguish "first run ever"
from "not comparable". **The product REPORTS the reset rather than leaving an operator to discover
it**: `GET /v1/evals/scoring-semantics` returns the changelog, per-version run counts and **exactly
which pinned baselines are stranded, by run id, with the action to take**; the ADR-0044 drift sweep
**PAUSES** a stranded pair with the reason stated instead of spending a model call to reach a
refusal it can predict; the run detail and every ADR-0045 model-card evidence entry carry the
version. **Any baseline pinned before 2026-08-07 must be re-pinned.** Two existing tests were
**REWRITTEN, not deleted**, each carrying a comment naming what changed and why: ADR-0067's
judge-boundary test (which had pinned the asymmetry in both directions and now pins the *unified*
boundary in both directions) and ADR-0044's `no_judge_configured` test. Gateway
**1,926 -> 1,942 tests / 111 -> 112 files**; shared **554 -> 561**; policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 unchanged. **Disclosed rather than
closed** (eight items in the ADR): the `eval_results` row for a blocked probe **still stores
`score: 0`** — correct for an ordinary quality suite, since polarity belongs to the red-team layer,
and the adjudication row is the authority; **`classifyDispatchFailure` is a DENY-LIST of transport
codes**, so a future transport code would be mis-read as a platform hold — it fails **towards**
claiming the defence worked, the wrong direction, named rather than hidden; there is **no SPA page**
(API only); nothing re-verifies a judged metric because no provider is connected; `redteam_runs` has
no admin-pinned-baseline concept so its reset is the resolution filter only; the version is global,
not per-dataset; pre-0072 `redteam_probe_trials` rows are not individually marked; and there is **no
down migration**, so rolling the code back with the column in place leaves rows stamped 2 that v1
code produced.

**Slice E of the parity wave shipped, 2026-08-07 — [ADR-0071](../docs/decisions/0071-shadow-ai-format-adapters.md),
shadow-AI evidence format adapters. THE PARITY WAVE IS COMPLETE** — six slices, one ADR each,
dispatched sequentially; see [COMPETITIVE_PARITY_PLAN.md](../docs/product/COMPETITIVE_PARITY_PLAN.md)
§5 for the closing summary and the three things the wave is *not*. **This slice needed NO MIGRATION
and that is a decision, not an omission**: 0083 was budgeted and left unused (it was later claimed
by ADR-0072), because
`shadow_ai_imports.summary` is already `jsonb NOT NULL` and carries the adapter id, the format
basis, the fields actually read, the three row counts and the bounded refusal list — adding four
columns to store what jsonb already stores would be migration cost with no query that needs it
(nothing filters imports by adapter). **The plan's original Slice E paragraph asked for importers
ADR-0055 had ALREADY SHIPPED** — four evidence kinds, dry-run/apply, payload fingerprints, per-row
provenance, forbidden-key screening, correlation, the coverage scorecard — and the paragraph was
corrected in the plan file before the slice started, which is the Slice D mistake caught by grepping
first. **The genuine gap was one layer down**: ADR-0055 accepts rows *already normalised to its zod
schemas*, so a customer had to hand-write the transform — and a hand-written transform is exactly
the ten-minute `split("|")` that works on the first three lines of the sample and mis-parses every
escaped line for ever afterwards. **Five adapters** on ADR-0069's registry playbook: `cef` and
`leef` (published grammars, header `\|` escaping and CEF's `\=` extension escaping honoured),
`w3c_extended` (driven by the file's OWN `#Fields:` directive, honoured again if it is redeclared
mid-file), `proxy_common` (Squid native / NCSA common / combined, with the layout a REQUIRED
operator assertion because those formats carry no header and a mis-sniffed layout reads the
client-IP column as the destination), and `generic_mapped` over CSV *or* JSON producing **all four**
evidence kinds. **An adapter LAYER, not a subsystem, and that is the structural claim**: no new
table, no new evidence kind, and `processEvidenceImport` is now ONE function that both the
row-shaped `POST /v1/shadow-ai/imports` and the new `POST /v1/shadow-ai/imports/raw` end in — the
suite **proves** it by asserting the two routes compute a byte-identical analysis from the same
evidence rather than asserting reuse in prose. Every adapter validates its output against
**ADR-0055's OWN row schemas**, which is what turns a `rows.417.destinationHost` zod path into a
refusal naming **line 418 of the file the operator has open**. **The escapes ARE the slice**:
`CEF:0|Acme\|Corp|…|suser=alice\=admin` parses correctly and the unit suite asserts the naive
`split()` gives a DIFFERENT answer, so a regression to string-splitting fails a test rather than
shipping a confident wrong host; **not one regular expression is evaluated over file content
anywhere** (ADR-0055's NO-REGEX-FROM-DATA rule verbatim — a CEF extension is precisely the
attacker-shaped string that turns a lazy alternation into a ReDoS). **Every line is read or REFUSED
WITH ITS 1-BASED FILE LINE NUMBER, and `onMalformedRow` DEFAULTS to refusing the WHOLE FILE**,
because the one unrecoverable failure for a discovery product is a quietly smaller inventory that
looks complete; `report_and_continue` is the explicit opt-in and still lists every refusal.
An unreadable epoch unit, `07/08/2026`, a W3C token-count mismatch, an NCSA line whose target is a
path (an origin-server log names no destination), a LEEF 2.0 sixth field that is not a delimiter, a
declared `devTimeFormat`, and an ambiguous `host`/`url` header pair each REFUSE with the reason
stated. **Three honesty fields, not one**: `capabilities` + a machine-readable `formatBasis`
(`published-spec` / `declared-format` / `operator-mapped`) + a `verification` sentence + `limits`,
all returned by `GET /v1/shadow-ai/adapters` — and every published-spec adapter says outright that
it **has NOT been run against a real vendor export**, asserted by a test so it cannot be quietly
softened. **No vendor-named preset ships, deliberately** (no `zscaler`, no `okta` — a test asserts
it): ADR-0069 disclosed its declared-header presets as its own biggest gap, a CASB/SSO export has no
published format at all, and the vendor's name is the part a buyer trusts. PII posture is
**ADR-0055's, unchanged and strictly NARROWER** — unmapped fields are discarded, so a CEF `msg` or
`cs1Label` never reaches the database; no ingest scan was added because an evidence row's only PII
is the `sourceIdentity` the feature exists to record. Coverage honesty is preserved verbatim at the
new surface, and emptying the catalogue makes every adapter match nothing (asserted — "detection is
data" had to stay true here too). Gateway **1,907 → 1,926 tests / 110 → 111 files**; shared
**500 → 550**; policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58
unchanged. **Disclosed rather than closed** (thirteen items in the ADR): **nothing has been run
against a real export from any vendor's product** — the biggest gap and the owner's first follow-up;
there is no vendor-named adapter at all; only a FIXED key list is read from CEF/LEEF, so a product
using custom `cs1Label` slots gets every line refused; one record must be one line (no multi-line
reassembly, no gzip, no multipart, 2 MB inline); the 5,000-row bound means a real proxy log must be
chunked or pre-aggregated and each log line counts as ONE request unless the format carries a count;
**re-posting the same file doubles a finding's `observationCount`** because ADR-0055 has no
duplicate-payload 409 (pre-existing, unchanged, now named); a row whose host does not normalise is
still DROPPED-and-counted rather than refused — ADR-0055's contract, left alone exactly as ADR-0067
left `llm_as_judge`, named follow-up; a naive timestamp is read as UTC; a LEEF feed declaring
`devTimeFormat` has EVERY row refused; the log grammars produce `egress_log` only; and there is no
SPA page.

**Slice F of the parity wave shipped, 2026-08-07 — [ADR-0070](../docs/decisions/0070-trace-observability.md)
(migration 0082), trace/span observability.** The premise was **verified by grep before anything was
written** (Slice D's was not, and was half wrong): there was **no trace or span model anywhere in
`schema.ts` and no OpenTelemetry dependency in any package.json**, while every FACT a trace is made
of already existed and was already governed — `orchestration_runs` and its node statuses, the
`usage_events` ledger, the hash-chained `audit_log`, the guardrail/eval/red-team/lineage ledgers.
**The gap was the SHAPE, not the data**: nothing could say *this call happened inside that node,
which happened inside that run; this tool call was asked for by that specific model turn; and the
reason there is no model call under this branch at all is that pillar 1 said no.* That last clause
is the whole slice — **a governance product's most valuable trace is the one that shows why NOTHING
happened**, and no incumbent (Langfuse/Helicone/LangSmith) is positioned to record it because none
of them is the thing that refused. **The recorder WRAPS the one dispatch attempt rather than being
scattered through it, and that is the argument**: `dispatchOnce` became `dispatchAttempt` with a
thin traced wrapper taking its name, so all ~12 of its early returns (virtual-key ceiling, MRM,
project budget, §8.4 PII, ADR-0042 guardrails, both egress refusals, missing credential,
undispatchable agent) land as `denied` spans carrying their stated reason **without the core
mentioning tracing at all** — a thirteenth refusal cannot forget to be traced. The pillar-1
entitlement denial never reaches the core, so it gets its own `policy` span at the invoke route AND
in the compat core; without that, the most common refusal in the product would be the one thing with
no trace. **A span REFERENCES, it does not restate** (`usage_event_id`, `audit_log_id`, `run_id`,
`node_id`, `agent_id`); the only duplication is the five fields a tree must render without an N+1,
copied FROM the ledger row in the same call, with the suite **joining back by `usage_event_id` and
asserting equality** rather than trusting the copy. An ADR-0066 **fallback hop is a CHILD of the
attempt that failed**; an orchestration run is **four real levels** (run → node → model turn → the
tool call that turn made), asserted by parent id and depth against a real run with a real MCP
upstream — a flat list relabelled fails every line. `seq` (not the timestamp) orders siblings,
because millisecond timestamps collide in-process. **Content rides the EXISTING ADR-0042/0044/0065
posture** (already-adjudicated text + truncation + the withheld marker; a refusal ABOUT the input
stores the marker, not the prompt), and **retention rides the §8.3 cascade's audit floor with no new
knob** — one would let an operator keep prompts for a year under a framework that says ninety days.
**Reading a trace is default-deny with a self exception** on ADR-0069's precedent: a non-admin
naming somebody else gets a **403, not a narrowed result set**. Export is the published `gen_ai.*`
OTel conventions over a **hand-rolled OTLP/HTTP JSON encoder** (the SDK rejected — we serialise
stored rows, we do not instrument a live process, and its background exporter assumes opening a
socket is fine), with **no default endpoint anywhere**, a real 409 when none is configured, and the
ADR-0034/0043 egress guard applied at write time AND on every export. **The SPA ships a trace-tree
page at `/admin/traces`** that leads with the traces where governance refused something and prints
each deny reason inline. **Measured**: a 2,000-span tree reads in **42 ms in ONE query**, assembles
in 7 ms, encodes to OTLP in 23 ms; the recorder costs two statements per span (≈400 spans/s).
Gateway **1,889 → 1,907 tests / 109 → 110 files**; shared **480 → 500**; policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 unchanged.
**Disclosed rather than closed** (twelve items in the ADR): a lost span is a **hole the API reports**
(`partial: true`) rather than prevents — the recorder never fails the call it traces; **connector
calls, workflow stages and eval-run grouping are DECLARED span kinds with nothing writing them**;
there is **no prompt-playground diffing** (named in the slice's own paragraph, not built); no
sampling and **no per-project tracing policy** (org-wide on/off only); no time-to-first-token
(streaming is traced at completion); the exporter is a **pull with no spooling, no retry and no
already-exported marker**, so an overlapping re-run re-sends; the OTLP **span id is the first 8
bytes** of our uuid (the trace id is exact); a DENY exports as OTel status **ERROR** because OTel's
enum has no member meaning "deliberately refused", so in somebody else's Grafana a refusal looks
like a failure; and **nothing has been verified against a live OTLP collector** (`dryRun: true`
exists so an operator can read the exact body first).

**Slice C of the parity wave shipped, 2026-08-07 — [ADR-0069](../docs/decisions/0069-cross-vendor-cost-consolidation.md)
(migration 0081), cross-vendor cost consolidation. This is THE WEDGE** — the one gap session 07's
research found genuinely unserved by any incumbent, because per-seat SaaS spend is **invoice-side,
not call-side**: every gateway attributes the traffic through it, and nobody consolidates one
human's Claude Code seat + Copilot seat + raw OpenAI key + Bedrock account into a per-person figure
FP&A can charge back. A pre-slice grep confirmed **no importer, no vendor-account→user identity
resolution, and — the load-bearing gap — no `metered` vs `imported` distinction anywhere in the cost
model**; every figure was implicitly metered with nothing to say so. **The blended total does not
exist as a matter of TYPE**: `consolidate()`'s return shape has no field for metered+imported, no
route computes one, and both suites walk the entire response body — every number at every depth,
numbers spelled inside sentences included — asserting the blend appears nowhere (fixtures chosen so
61.11 + 146.30 = 207.41 can arise no other way; a future convenience `total` fails four tests).
**The distinction is a CHECK constraint, not a convention**: imported money lives in its own table
with `basis` pinned to `'imported'` in the database — a column on `usage_events` would have been
less code and was rejected because every existing statement/forecast/budget query reads that table
and one missed `WHERE` puts an unverifiable restated figure inside a customer's invoice.
**Five adapters** on the model-provider/infra-provider playbook (registry + declared capabilities +
an honest `limits` string the API returns): `generic_mapped` (CSV *or* JSON, deliberately the good
one — the long tail is longer than any preset list; header inference **refuses on ambiguity**),
`openai_console`, `anthropic_console`, `aws_cur` and `seat_roster` (the wedge case — and its price
is an **operator assertion**, stamped `derivedFrom` on every line). **Never trust the file**:
character-scanned parsers (no regex over imported text, ADR-0055's rule verbatim), an ambiguous
`07/08/2026` **refused** rather than guessed, an empty amount refused because it is not zero,
`rows_parsed = rows_accepted + rows_refused` as a DB CHECK, and every refusal naming its **file line
number** — the suite parses the same file clean and then corrupted and asserts the corrupt parse
does not simply return less money. **Identity resolution is admin-authored and honest**: alias →
exact email → domain rule → unresolved, in that precedence so a human's correction beats a
mechanical match; ambiguity resolves to NOBODY; an unmatched account stays visible as its own
unattributed subject and is **never spread pro-rata**; every line records HOW it matched and every
correction re-resolves stored lines and audits its blast radius; deleting a user un-attributes their
spend rather than deleting it. **Default-deny both ways** — importing and fleet-wide reads are
admin-only, the single non-admin route refuses unless the caller IS that user. Re-applying identical
bytes is a real **409** (partial unique index); the correction path is revoke-then-reimport, and the
revoked batch row survives. **PII**: the same ADR-0042/0065 ingest path, with the **account column
exempt by construction** — the email IS the join key — disclosed in the code, in every response, on
the registry and in the ADR. Gateway **1859 → 1889 tests / 108 → 109 files**; shared **427 → 477**;
policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58 unchanged.
**Disclosed rather than closed**: the three vendor presets are built against **DECLARED header sets
never verified against a live console** (they refuse naming the missing column rather than
mis-parsing, and `generic_mapped` is the escape hatch — this is the biggest honest gap and the
owner's first follow-up); `aws_cur` reads unblended cost only so a Savings-Plan-heavy account will
not reconcile; **imported figures never enter billing statements, budgets, forecasts, the optimizer
or any enforcement path** (reporting-only, deliberately — we will not block work on a number we
cannot verify); no FX conversion; no invoice-total reconciliation; no cross-chunk dedup for an
operator-split CUR; `users.cost_center` has no history; **no scheduled re-import** (nothing to poll
— the view reports its own staleness instead); and **no SPA page** (API + CSV only, same posture as
ADR-0066).

**Slice B shipped the same day — [ADR-0068](../docs/decisions/0068-redteam-depth.md) (migration
0080), red-team probe-corpus depth**: N-trial runs with a Wilson-interval ASR and per-trial outcomes
stored, an offline versioned corpus v2 across ten attack classes, multi-turn crescendo/many-shot
sequences, and agentic probes whose induced tool/connector call is adjudicated by the **real**
entitlement kernel and never executed. Read its "what this explicitly does NOT give you" before
citing any rate: `trials` defaults to 1 and a one-trial run is labelled `single-trial`, probe
grading is unverified because no provider is connected, and against the deterministic provider N
trials buy a denominator rather than variance. See
[docs/decisions/README.md](../docs/decisions/README.md) for the full row.

**Slice A of the parity wave shipped, 2026-08-07 — [ADR-0067](../docs/decisions/0067-groundedness-evaluation.md)
(migration 0079), groundedness/faithfulness/hallucination measurement.** A pre-slice grep found **no
groundedness, faithfulness, hallucination or claim-attribution metric anywhere in the codebase** —
the one measurement a regulated buyer asks for by name, and one that could not have been added by
configuration because `eval_cases` had nowhere to put the CONTEXT an answer is supposed to rest on.
Migration 0079 adds `eval_cases.context` (an **array**, one entry per retrieved chunk — chunk
boundaries are the metric: a claim stitched out of fragments of three unrelated documents is exactly
the fabrication this catches, and a single blob scores it as supported; there is a test asserting the
stitched claim is refused) plus `context_in_prompt`, which records whether the model SAW the context
or whether it was held back for scoring only. Context is **not a bypass** — when it rides the prompt
it IS the dispatch input and takes the same §8.4 PII and ADR-0042 guardrail path; extracted claims are
slices of `outputText` AFTER the withheld-marker substitution. A case with no context dispatches
byte-identically, so **no existing baseline moved**. **Four metrics that genuinely work offline with
no key** — `claim_support` (IDF-weighted coverage of the single best chunk, failing claims stored
VERBATIM, fabricated FIGURES named and capped below threshold outright), `context_precision`
(retrieval utilisation), `context_recall` (measures the RETRIEVER — high support with low recall is
the signature of a model faithful to context that never held the answer), `answer_relevance` (with an
abstention detector scoring 0 and saying why). **Proved adversarially**: every score assertion is
paired with its opposite over the SAME context and the GAP asserted — end to end through the real
harness a grounded answer scores **1.00** and a same-length same-topic fabricated one **0.00**;
precision 1.00 tight vs 0.20 padded; relevance 0.73 vs 0.00. **The honesty line is the point**:
`groundedness_judge` / `answer_relevance_judge` return a real **422** (`judge_required` /
`judge_not_dispatchable`) from a pure, exhaustively-tested `judgeAvailabilityFor` placed BEFORE the
`eval_runs` insert, and the suite asserts **no run row, no result row, not one dispatched token** —
they never degrade to the lexical proxy under the judged name. The tokenizer was **hoisted** (not
copied) out of `training-provider` into `@regulait/shared`, which now owns the one tokenizer.
Gateway **1,815 → 1,835 tests / 106 → 107 files**; shared **360 → 402**; policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 all unchanged. **Disclosed rather than
closed, and several limits are THEMSELVES tests so they cannot silently become untrue**: the lexical
metrics cannot see negation flips (flagged, not scored) or swapped attribution, and score a
synonym-only paraphrase as unsupported (a false positive — the direction that hurts);
`context_precision` is utilisation, not Ragas's rank-aware precision; `answer_relevance` scores a
fluent falsehood HIGH; the judges' JUDGMENT is unverified because no provider is connected (plumbing
proven, instrument not); **ADR-0044's `llm_as_judge` deliberately still scores an unjudgeable case
zero rather than refusing** — unifying it would change an accepted ADR's contract from inside a slice
about a different metric, so it is named follow-up for the owner; and there is no retrieval
integration, no embedding similarity, and no groundedness *reporting* screen (the eval page gained a
context field so the new kinds are authorable, and the model card renders the summary).

**Competitive-parity wave started, 2026-08-07 — ADR-0066 (migration 0078) is Slice D of
[docs/product/COMPETITIVE_PARITY_PLAN.md](../docs/product/COMPETITIVE_PARITY_PLAN.md).** That plan
exists because session 07's research **falsified all three assumed differentiators** (per-user
gateway governance, in-gateway cost attribution, governed SDLC workflow are each already served by
LiteLLM/Portkey/Cloudflare/Helicone/Langfuse); read its §0 before repeating the claim. With RegulAIt
likely to ship as **freeware**, parity gaps are adoption blockers rather than competitive risks,
which is the basis on which the wave is worth doing. **Slice D shipped four things, each designed so
it may only ever NARROW** — the same ceiling shape ADR-0062 used for egress: (1) **`GET /v1/models`**,
the discovery endpoint every off-the-shelf OpenAI client calls at setup and without which a tool
fails *before* the first completion — one route, two envelopes (OpenAI by default, Anthropic when
the SDK's `anthropic-version` header is present), both rendered from one entitlement filter that
runs the **same `evaluateAgent` the dispatch path runs**, so an ungranted model is ABSENT rather
than listed-then-403'd (proved with two users on disjoint grants, neither seeing the other's);
(2) **virtual keys** (`rglv_`, reusing the api_keys sha256 hashing verbatim) carrying an owning
user, optional model allow-list, optional USD budget + spend counter, optional expiry, revocation
and an optional pinned platform credential the holder never sees — `isAdmin` hard-coded **false**
whatever the owner is, and a **default-deny five-route allow-list** that makes minting keys,
editing grants and reading credentials structurally unreachable (plus a by-kind refusal at
`/auth/login-with-key`, since exchanging a virtual key for a session would hand back the identity
it exists to narrow); (3) **per-key model allow-lists enforced at BOTH the compat surfaces and the
native dispatch path**, inside the one `dispatchOnce` core against the SERVED agent *and* at the
entry points against the REQUESTED agent (because `dispatch:false` never reaches the core); and
(4) **provider fallback chains** whose subtle rule is that **a governance DENY is not a failure** —
only a transport/upstream error triggers a hop, entitlement is re-evaluated per hop from scratch
in the same mode, egress posture is re-evaluated per hop because each hop runs the whole core, and
every hop is audited and disclosed. Gateway suite **1,764 → 1,815 tests across 106 files**.
Disclosed rather than closed: no load balancing, no retry/backoff, no per-key budget *period*
(lifetime cap; rotate the key), no per-key rate limits, pinning is platform-credential-only,
fallback is one level deep by construction, `GET /v1/models` is gated on the interception surfaces,
each failed hop bills its own usage row, and there is **no SPA page** for either feature (API-only).

**Note on the two preceding slices, which shipped after this file was last caught up**:
[ADR-0064](../docs/decisions/0064-in-process-scheduler.md) (migration 0076) added the in-process
scheduler that six ADRs' sweeps had been missing, and
[ADR-0065](../docs/decisions/0065-regulait-llm.md) (migration 0077) added RegulAIt-LLM. The
paragraph below still describes the world as of ADR-0063 and has NOT been rewritten; treat
[docs/decisions/README.md](../docs/decisions/README.md) as the authority for anything after 0063.

**RegulAIt is a working, deployed product, not a scaffold.** All eight P0 pillars have shipped
functionality; the gateway suite is at **1,689 tests** across 103 files (policy-kernel 129,
workflow-kernel 39, `packages/shared` 360, model-provider 122); the schema is at **migration
0075**; and **every ADR is now Accepted — 0001 through 0063, with nothing left Proposed**.
**[ADR-0063](../docs/decisions/0063-data-key-custody.md) (migration 0075) closed the top deferred
security item — the `REGULAIT_DATA_KEY` custody gap — without weakening the decision that created
it.** ADR-0035 deliberately keeps the envelope key OUT of the backup, which is correct and
unchanged; what was missing was the procedure around it. The gateway now derives a **non-secret**
fingerprint of the key (`dk1:` + truncated `HMAC-SHA256(key, "regulait/data-key-fingerprint/v1")`),
records it in `data_key_state`, prints it in the boot posture block beside proxy/HSTS/egress, and
writes it into every backup's manifest, S3 object metadata, `RESULT=` line and status file — so a
restore runbook answers *"do I have the right key for this dump?"* from `head-object`, **before**
restoring. On boot it records the fingerprint on first run (probing real stored ciphertext first,
so the very first boot after upgrade cannot record the WRONG key), verifies it thereafter, and
**REFUSES TO START on a mismatch** — the restore-onto-a-new-box case — naming both fingerprints.
Custody itself is an append-only, audited **attestation** whose limit is stated wherever it
appears: it records a human's claim and cannot verify custody; what it buys is that its ABSENCE is
visible on the boot line, in the portal, and in every backup run plus a separate `DataKeyAttested`
metric. Full re-encryption under a new key is **named follow-up scope, deliberately not
half-built**.
**[ADR-0062](../docs/decisions/0062-mode-scoped-egress.md) (migration 0074) closed the last open
finding in [docs/deployment/DATA_BOUNDARY.md](../docs/deployment/DATA_BOUNDARY.md) §4**: the
ADR-0034/0043 egress guard adjudicated only admin-*typed* URLs, so on an air-gapped box a stored
credential — or a bare `ANTHROPIC_API_KEY` — made an agent dispatch attempt the vendor's public API
carrying the prompt, with only the absence of a network route stopping it. A deployment-wide egress
posture is now derived from `REGULAIT_DEPLOY_MODE` (hosted/byoc permissive, `air_gapped` **strict**)
and `org_settings.egressCompiledDefaultPolicy` may only TIGHTEN it — the env, not a portal toggle,
per the ADR-0029 HSTS precedent, because an air-gapped posture a compromised admin could switch off
from a web form is not one. Under a strict posture an adapter that would run on its *compiled*
vendor endpoint is refused before it is constructed, against the same `egress_allow_hosts` table. The entire
enterprise-readiness set (**0036–0061**) was built, verified and merged in one session
(PR #105, `27205e7`) — see
[docs/product/ENTERPRISE_READINESS_PLAN.md](../docs/product/ENTERPRISE_READINESS_PLAN.md) for the
bucketing and [docs/decisions/README.md](../docs/decisions/README.md) for what each one actually
enforces.
**Enterprise identity is real**: SAML 2.0 *and* OIDC federate side by side, SCIM 2.0 provisions
and instantly deprovisions, IdP groups drive roles under default-deny, sessions are individually
revocable inside an admin-defined network envelope, and an in-process Cedar ABAC layer can
conditionally restrict — never widen — any call the RBAC kernel already allowed.
**The governance surface is real too**: a guardrail engine at all three governed entry points, an
eval harness that blocks promotion on regression, model-risk cards with an enforced expiry gate,
a review workbench with per-item-authorized bulk actions, entitlement-scoped executive reporting,
immutable prompt versioning with deterministic canary and rollback, spend forecasting that
refuses to fabricate a number, a lineage graph that hides existence rather than just content,
metering-derived billing, an offline-verified license, a published OpenAPI contract with
drift-detection tests, a resumable onboarding wizard whose import cannot escalate privilege,
shadow-AI discovery, a governance copilot that is itself governed, continuous red-teaming,
compliance packs computed from the real ledgers, policy-simulation blast radius with a proven
zero-dispatch guarantee, a hash-chained tamper-evident audit log, and ChatOps approvals bound to
a real human.
**Two things are deliberately NOT true yet, and are load-bearing caveats** (each recorded in its
ADR's amendment rather than implied away): no model provider is connected, so every
model-dependent claim is mechanism-proven and judgment-unverified; and there is **no in-process
scheduler**, so every "scheduled" sweep is an operator/cron-driven endpoint. The third caveat this
paragraph used to carry — the **air-gapped boundary has a real hole**, because the egress guard
adjudicated only admin-*typed* URLs and a built-in provider still reached its vendor's public API
with the network rather than the application as the backstop — was **closed by ADR-0062**
(migration 0074). It is now code-enforced under `REGULAIT_DEPLOY_MODE=air_gapped`, with the honest
residual (a mis-set env var, an adapter whose default is not statically knowable, and the process-
level surfaces the gateway does not mediate) recorded in `docs/deployment/DATA_BOUNDARY.md` §4.1. The product is served by a **React SPA** (`apps/web` —
React 18 + Vite + react-router + TanStack Query, an owned token design system, light/dark, six
grouped nav sections) at **`/ui`**, which is now the *only* UI: `/`, `/app` and `/admin` all 302
there. The template-literal shells are **deleted** as of ADR-0033 (−7,125 lines): the SPA is not
merely the default UI, it is the only one, and `/legacy/*` serves nothing.
Humans authenticate with **real auth** — scrypt passwords, revocable server-side sessions
(HttpOnly/SameSite cookies + a CSRF header), audited lockout, TOTP MFA, and OIDC SSO with PKCE and
default-deny JIT provisioning (ADR-0025); API keys remain the programmatic/IDE credential.
**IDE interception** ships as provider-shaped translation shims (`/v1/messages`,
`/v1/chat/completions`) over the one governed dispatch core, admin-gated and off by default
(ADR-0020/0024). Everything runs on the dev EC2 box, now over **real HTTPS** at
**`https://3-229-246-126.sslip.io`** — a browser-trusted Let's Encrypt certificate terminated by
Caddy on-box, at zero AWS cost (ADR-0029). Still **dev-grade, explicitly NOT production**. The
box **powers itself off outside 08:00–20:00 Mon–Fri America/New_York** (ADR-0032) on an Elastic
IP, so the address — and therefore the URL and its certificate — survives the cycle. **CI is
live again** on a 2,000 min/month budget.
**What is NOT done**: no real model provider is connected (the owner's key is parked and must not
be raised until they raise it), and the deployment is a single EC2 box with Postgres in a
container volume — now with a **nightly verified `pg_dump` to S3** (ADR-0035, applied and proven
by a real restore), so the largest remaining risks are the single point of failure itself and the
fact that `REGULAIT_DATA_KEY` is not recorded out-of-band (a restore onto a new box recovers every
row and leaves every credential undecryptable). Both are tracked in
[docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md](../docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md).

The infrastructure bootstrap phase (EPIC-01) is **complete**. The private GitHub repo
[dhruvmahendrapatel/RegulAIt](https://github.com/dhruvmahendrapatel/RegulAIt) is live with the
full scaffold. AWS is a two-account Organization (Management `913436627353` / Workload
`regulait-dev` `517506432475`), IAM Identity Center only (no long-lived keys), and the full
security baseline — org-wide CloudTrail, GuardDuty, Security Hub (FSBP + CIS standards), AWS
Config with a cross-account aggregator, account-level S3 Block Public Access, a $5/month Budget,
3 SCPs, and all three permission sets (`Admin-BreakGlass`, `Deploy-Builder`, `ReadOnly-Audit`) —
is applied via Terraform (`terraform plan` reports zero drift). The `github-oidc-role` module is
authored but intentionally not wired into `main.tf` yet — no workload exists to deploy.
Full narrative, including two real incidents worth reading before touching this infra again, is
in `sessions/2026-07-21-session-01.md`.

**Product scope escalated twice more, 2026-07-24: now eight co-equal P0 pillars, not two.**
ADR-0007 (six pillars) added infra-ops/compliance-cascade/deployment-model, Shared Projects, and
a cost-per-project dashboard to
[GOVERNANCE_LAYER_SPEC.md](../docs/product/GOVERNANCE_LAYER_SPEC.md) (now §8–§10), and escalated
token/cost optimization to full P0 pillar in
[TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md). ADR-0008 (eight
pillars) added two more, each in its own new spec doc:
[MULTI_AGENT_ORCHESTRATION_SPEC.md](../docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md) (pillar
7 — PM→Team-Lead→Worker delegation, task-graph DAG, entitlement inheritance never escalation,
per-run budget caps) and
[PM_TOOL_INTEGRATION_SPEC.md](../docs/product/PM_TOOL_INTEGRATION_SPEC.md) (pillar 8 —
Azure DevOps/Jira/etc. as the system of record, not a shadow copy). `CLAUDE.md` and `VISION.md`
updated to list all eight. **No AWS/Terraform infrastructure change was needed for either
escalation** — nothing is deployed yet (EPIC-02 through EPIC-06 haven't started), so both were
spec-only updates.

**EPIC-02 started, 2026-07-24 (session 02).** Stack chosen and recorded as ADR-0009 (TypeScript
end-to-end: Fastify + official MCP SDK planned, hand-rolled pure policy kernel, Postgres +
Drizzle, pnpm monorepo). First vertical slice of MCP-server governance is **built and green**
(21 tests: 13 kernel unit, 8 gateway integration against Postgres 16): `packages/policy-kernel`
(default-deny, per-user×server×tool allow-lists, read-only-all server grants, typed
`Decision {effect, ruleId, ruleChain, reason}`), `packages/db` (schema + first migration:
users/mcp_servers/mcp_tools/tool_grants/server_grants/audit_log — audit rows deliberately have
no FKs so they survive deletions), `packages/shared` (zod schemas), `apps/gateway` (Fastify:
admin CRUD, `/v1/evaluate` writes an audit row for every decision, visible-tools endpoint
implements §3's visibility filtering). Work is on branch `claude/status-check-2gbrwf` (draft PR).
**Not yet in the slice**: initiatives object type, admin portal.

**Review fixes + git-provider abstraction (PR #10).** The PR #8/#9 adversarial reviews'
confirmed findings are fixed (2 critical: stage-scoped approval events kill cross-stage
approval forgery; transactional FOR-UPDATE event application kills decision races; plus
supersede-all on re-open/deny/abort, merge-conflict-throwing template merge, approver
validation at template creation, declared-modes enforcement, ceiling-preserving partial
agent-policy upsert, revocable agent/connector grants). Then `git_operation` became a real
executable stage type: new `packages/git-provider` (provider-neutral interface; GitHub REST
adapter with injectable fetch; in-memory mock for tests/air-gapped dev; GitLab/Bitbucket/ADO
interface-ready but explicitly rejected until implemented), `git_connections` with
AES-256-GCM-encrypted tokens (REGULAIT_DATA_KEY; storage refused without it, migration 0009),
and a gateway executor: create_branch → open_pr (body auto-linked to the signed-off
requirements artifact, §2 stage 7) → merge (configured strategy) with results in
instance.context, failures retryable via /advance, everything audited.

**Real model dispatch, 2026-07-25 — the estimates-to-actuals unblocker.** New
`packages/model-provider` on the git/pm-provider playbook: neutral `ModelProvider` interface
(`dispatch(model, input, …) → {outputText, stopReason, refusal, usage}`), an Anthropic adapter
on the official `@anthropic-ai/sdk` (injectable fetch — unit tests never touch the network;
`stop_reason: "refusal"` handled explicitly: refused content is NEVER surfaced as an answer),
an in-memory mock (input `<<refuse>>` triggers the refusal path for e2e tests), and a registry
that rejects openai/google/xai until implemented. Placement is the whole point: dispatch runs
strictly AFTER governance and AFTER routing in `/v1/agents/:id/invoke` (`dispatch: true`) — the
provider package is handed the served model id as an input and never picks one, so widening
entitlement is structurally impossible. Config problems fail explicit (409
`agent_not_dispatchable` / `no_model_credential`), never fall back to a different model.
Migration 0016: `agents.model` (provider-native id; null = decision-only),
`model_credentials` (one per provider, AES-256-GCM under REGULAIT_DATA_KEY, write-only API —
never returned), and `usage_events` — pillar 5's MEASURED actual-spend ledger, deliberately
distinct from estimate-based `cost_events`: provider-reported token counts × the served agent's
list price (unpriced = null, a measured token count never becomes an invented dollar), plus
`measuredCostSavedUsd` — what the routing baseline would have cost at the SAME measured
volumes — upgrading pillar 6's savings claim from estimated to measured per dispatch.
`GET /v1/usage-events` mirrors the cost-events read surface (admin fleet-wide, non-admins
forced to self; totals include measured spend + measured savings). Every dispatch is audited
(model, stopReason, refusal in the agent audit row). **Second slice: worker-node dispatch —
orchestration runs execute for real.** The dispatch core is extracted as a shared
`executeGovernedDispatch` and `POST /v1/runs/:id/nodes/:nodeId/dispatch` runs a started
(`in_progress`) node's work through it: the node's CURRENT owner is executed exactly as
assigned (no routing at execution time — owner selection already happened, entitlement-checked,
at plan/re-plan/reassign), and §5.1 is re-checked at dispatch time under the INITIATING user —
a grant revoked mid-run stops the worker cold (403, audited). The state machine stays
authoritative: dispatch produces output (returned + recorded as a `node_dispatched` entry in
the run's append-only history, truncated), it never moves the node; a worker refusal is
surfaced honestly and the node does not advance. §5.2 gains MEASURED enforcement alongside the
estimate-based node-start gate: `budget.measuredSpentUsd` accumulates real dispatch cost; the
first cap crossing is allowed (measured cost is only knowable after the call) but escalates
immediately into the one approvals queue (`__budget__:<node>`, audited require_approval), and
every dispatch after it is blocked (409) until the named approver sanctions the overage.
usage_events rows carry `{runId, nodeId}` attribution. **Third slice: auto-dispatch of ready
nodes.** `POST /v1/runs/:id/auto` is a self-driving pass with the same gates and zero new
authority — one synchronous call (no scheduler/queue, ADR-0010's bias), starting the run if
needed then repeatedly taking the first ready node through the SAME machinery the manual
endpoints use: estimate gate → node_started → governed dispatch (§5.1 re-check per node) →
node_submitted. Review stays a human gate BY DEFAULT — nodes land in_review and dependents
wait; only an explicit `acceptReviews: true` also accepts each submission (audited in the
event history like any acceptance). Node-level problems (entitlement denial, config gap,
worker refusal) mark that node failed/blocked — §3's retry/reassign/escalate applies — and
the pass keeps driving independent branches; run-level problems (estimate or measured budget)
stop the whole pass, with the measured-budget check running BEFORE node start so a blocked
pass never strands a node in_progress. Per-node inputs via `inputs` map (title fallback),
`maxNodes` cap per pass, every pass summarized in one `run-auto-advance` audit row. **Fourth
slice: workflow build-stage nesting (§8 of both EPIC-03 and EPIC-05).** An `automated_build`
stage may carry a `run` config — an orchestration task graph, opaque to the workflow kernel
(the GATEWAY validates it with the orchestration kernel at template creation, plus the graph's
escalation approver — fail-fast, a template never promises a graph the engine can't run). The
stage then executes via the same `awaiting_execution`/`execute_stage` machinery as git stages:
the executor spawns a nested run through the same `planRun` the runs API uses, planned under
the **workflow initiator's** entitlements (a workflow can never launch a run its human
couldn't; an unentitled graph fails the stage explicitly with the plan rejection in
`context.lastError`, retryable via /advance once granted). The nested run is a first-class
run — visible at `/v1/runs/:id`, bound via `workflow_instance_id` (waiting since migration
0011), driven manually or by `/auto` — and the run-event funnel notifies the parent when it
turns terminal: completed → `execution_succeeded` (flowing straight into downstream stages),
aborted → `execution_failed` with the stage retryable (retry spawns a FRESH run; a live or
completed run is never duplicated — idempotent like branch creation). The kernel forbids
human-triggering a build-with-run stage — no bypassing the governed execution. **Fifth slice:
signed-off artifacts in nested-run worker prompts — §2's scope-lock made real.** When a
dispatched node belongs to a workflow-bound run, `buildNestedRunContext` injects the
workflow's SIGNED-OFF artifacts as the model's system context ("execute strictly within the
signed-off requirements below; do not expand scope") — the build executes against exactly
what was approved, never a re-imagined version. The build stage's `scope` narrows the context
to that one artifact; without it, the latest version of every artifact is included; artifact
edits re-open the workflow upstream, so a re-run always carries the re-signed version. §6
traceability: the exact `{output, version}` list that framed each execution is recorded in
the `node_dispatched` history entry. Standalone (non-workflow) runs stay system-free —
verified down to the provider call via the shared mock's dispatch log. **Sixth slice:
per-user model credentials (BYO key).** Migration 0017: `user_model_credentials` (unique per
user×provider, AES-256-GCM, write-only like every credential surface). Self-service
`POST/GET/DELETE /v1/users/:id/model-credentials` (self or admin; other users' credentials
are 403-invisible). Dispatch resolution order: the BILLING user's own credential → platform
`model_credentials` → explicit `no_model_credential` failure; the ledger records
`credentialSource` (user|platform|none) on every usage event and in the dispatch response —
spend on a user's key is visibly not platform spend. Verified end-to-end against a local fake
Anthropic Messages server: the real adapter's actual `x-api-key` header carries the user's
key when one exists, falls back to the platform key when deleted, and precedence is restored
on re-add. Not yet: streaming, multi-turn dispatch, openai/google/xai adapters.

**Pillar 5 lands — per-project cost dashboard rollup, 2026-07-25.** Migration 0018: a minimal
`projects` entity (name, cost-center for chargeback, budget + named budget approver, overage
flag — membership/sharing semantics deliberately deferred to pillar 4's Shared Projects; until
then any authenticated caller may attribute, noted) plus FK-free `project_id` attribution
columns on BOTH ledgers (cost_events estimates, usage_events actuals) and on
runs/instances/approvals. **Attribution at the point of every gateway call**, exactly as the
pillar demands: `projectId` on direct invokes (validated at entry), on run creation (every
node dispatch bills to the run's project), and on workflow instances (nested runs inherit it —
the whole Intake→build chain bills to one project). **Budget enforcement in the dispatch
core**: measured spend at/over budget blocks further attributed dispatches (409) with the
first crossing allowed-but-escalated into the ONE approvals queue (objectType "project",
`__project_budget__`, named budget approver); the decide endpoint's approve lifts enforcement
(audited), deny keeps it. **The dashboard**: `GET /v1/projects/:id/costs` (admin FinOps
surface) — measured totals + tokens + measured savings, showback breakdowns by user and by
agent/model, estimated-savings-by-technique from cost_events, budget-vs-actual
(remaining/overBudget/overageApproved), and a labeled last-7-days run-rate forecast to end of
month; `GET /v1/projects` lists per-project spend fleet-wide. Not yet: MCP-proxy cost-event
attribution, per-project (rather than global) overage windows.

**Pillar 4 lands — Shared Projects MVP, 2026-07-25 (ADR-0011).** Shared-Project semantics
extend the ONE `projects` entity (no second container): migration 0019 adds `teams` +
`team_members`, `project_members` (per-user Owner/Contributor/Viewer, decoupled from
home-team role, optional contributing team validated against real team membership), an
append-only `project_context_items` store, and `projects.arbiter_user_id`. **The context
store is §9.2 literally**: every write is a new revision with provenance (user, team,
timestamp, optional source artifact); the current value of a key is its highest ACCEPTED
revision; once a key exists a write must name the accepted `baseRevision` it is based on
(409 otherwise — read-before-write is explicit, never a silent overwrite); a stale-base
write is RETAINED but not accepted and routes to the project's named arbiter through the ONE
approvals queue (`__context_conflict__:<itemId>`); approve makes it the new current value,
deny keeps it retained-but-never-current — every side of every conflict is a permanent row.
An arbiter-less project rejects conflicting writes explicitly (422). **Promotion (§9.4)**:
`POST .../context/promote` copies a workflow artifact into shared context (key = output,
`sourceArtifactId` provenance) — only the artifact's own instance initiator may promote.
**§9.3 honored precisely**: membership widens context visibility and attribution ONLY — a
contributor with no agent grant still hits default-deny (tested); and per ADR-0011, once a
project has members, only members/admins may attribute spend/runs/instances to it (memberless
projects stay open pillar-5 buckets). Everything audited as objectType "project". Deferred:
cross-team cost rollup views (§9.5), §9.4's suggested UI, SCIM team sync.

**Pillar 3's centerpiece lands — the §8.3 compliance-classification cascade, 2026-07-25.**
Classifications are multi-valued FRAMEWORK tags (hipaa/pci-dss/soc2/custom — the spec defines
no strictness ordering among frameworks, so nothing invents one) on the one `projects` entity
(migration 0020, plus `teams.default_classifications` and admin-editable
`compliance_profiles` — the entire cascade expressed as data, per-tag: required workflow
templates, MCP default mode, audit-retention days, PII mode; policy-as-code via API, §5/§8.5).
Profiles compose ADDITIVELY: template unions, mcp tightens to read_only if any says so,
retention takes the max, pii takes the strictest of the three defined modes (block>warn>log —
an ordering the spec does define). **The workflow dimension is ENFORCED**: at instance
creation a classified project's required templates union into the matched set ("no manual
per-control setup") and can FORCE a workflow when no assignment rule matches — the §4
strictest-wins merge carries every added sign-off stage; the admin explicit-template escape
hatch cannot skip it. **The other three dimensions are declared, honestly**:
`GET /v1/projects/:id/compliance` returns the effective policy with per-dimension enforcement
labels (`enforced-at-instance-creation` vs `declared-not-enforced`) — the estimationBasis
discipline applied to compliance. **Reclassification is diff-then-approve** (the spec's most
concrete behavior): first classification applies directly (audited); any CHANGE computes the
before/after effective-policy diff, pends in `pending_classifications`, and opens a
`__reclassification__` approval for a named reviewer through the ONE queue — approve commits,
deny discards, never silent. **§9.3 precedence**: a member team whose default classifications
aren't covered by the project's is surfaced at member-add (response + audit row,
`governing: "project"`), never silently resolved. Deferred: enforcement points for
mcp-default/retention/pii (detector + pruning jobs), reapply-to-in-flight on reclassification
(diff covers the policy; in-flight instances keep their merged definitions), per-framework
cost-governance policies (§8.6→§10.3).

**Demo-readiness sweep — the product becomes CLIENT-PRESENTABLE, 2026-07-25.** After the user
tested the deployed stack ("UI looks okay, functionality still looks incomplete"), a 15-agent
audit produced 126 verified gaps with one diagnosis: ~98 REST routes behind eight working
kernels, but the UIs called only 11/22 of them, the seed created no integrations, and nothing
could be *created* from a browser. Seven slices fixed this (commits 94bfb5f, d012f01, 198704e,
plus the fix pass): (1) the seed now populates every object type with real dispatched spend;
(2) credential/key layer — platform + BYO model credentials, one-time API-key reveal, agent-
policy editor, zero raw-UUID inputs; (3) closed approval loop — approver reads, inline
artifact previews, decision reasons, audited admin override; (4) New Run form (canned DAG
templates + advanced JSON), per-node instructions, project create/PATCH, teams; (5) full
pillar-4 write surface — context editor with baseRevision contract, history, promote,
conflict arbitration with both texts; (6) pillar-2 admin home + seeded 10-stage pipeline
(intake→…→sign-off→nested build→checks→branch→mock PR→merge gate→merge) drivable end-to-end;
(7) pillars 5/6/8 in /app — spend page, DAG SVG with elapsed/abort/reassign/escalate, honest
stop reasons, true parallel waves, PM strip + connections tab. The mock provider now returns
intent-shaped tier-differentiated replies (echo bot dead); orchestration routing respects
credential dispatchability. A three-persona headless-Chromium drive (~50 screenshots) and a
fresh-eyes judge returned "demo-ready-with-caveats" with 6 must-fixes — all fixed and
re-verified live (atomic decide + superseded stale approvals, PM mirror upsert + honest sync
+ orphan handling, compact approvals queue with friendly labels, zero console errors on
approver cross-reads, names instead of UUIDs in human-facing strings, self-review guard with
mandatory reason). Suite: 293 → **365 tests**, all green.

**First AWS deployment — the dev demo stack is LIVE, 2026-07-25 (ADR-0013).** The user
explicitly requested an AWS deployment for hands-on testing (cannot run locally); explicit
sign-off obtained in-session via an IAM Identity Center device-code login (Admin-BreakGlass,
workload account). New reusable module `infra/modules/app-instance` (single AL2023 EC2 box,
IMDSv2-only, SSM Session Manager access with NO ssh keypair, pulls a source tarball from a
module-owned private S3 bucket, `docker compose up -d --build` with per-deploy random
runtime config) composed into `infra/environments/regulait-dev-app` — its own state key
(`regulait-dev-app/terraform.tfstate`) so app deploys can never re-plan the org/security
baseline. Applied: instance `i-013c62adc887c76bb`, `http://3.237.199.248:3000` (/app +
/admin verified 200 through the public IP; seed keys handed to the user in-chat, never
committed). Dev-grade by declaration: HTTP only, port open to the world but everything
key-gated, demo data, ~$15–30/mo (will trip the $5 foundation budget alert — expected).
Teardown = `terraform destroy` in `regulait-dev-app`. NOT production; anything beyond demo
use needs a new decision + explicit sign-off. Operational notes: registry.terraform.io is
blocked from the remote dev container — providers install via a filesystem mirror fed from
releases.hashicorp.com (see session log); Terraform runs with the `regulait-admin` SSO
profile, state backend via `regulait-management`.

**The product becomes USABLE, 2026-07-25 — four slices in one push.** (1) Quickstart
plumbing: the gateway converges its schema on boot; `GET /v1/me`; own-scoped list views for
non-admins (runs/instances = own, projects = memberships); an idempotent demo seed driven
through the real HTTP API (three users with keys printed once, seven agents — three mock ones
usable with zero external keys — templates, hipaa profile, budgeted + classified projects, a
planned run, and an instance already awaiting sign-off). (2) `/app`, the end-user workspace:
one dependency-free file on a new shared design system (`ui-theme.ts` — warm dark, terracotta
accent, mono-for-data): a streaming Playground where every exchange shows routing, measured
cost, model, BYO-key, budget alerts, refusals + a collapsible governance trace; Runs with live
node states, per-node outputs, auto-advance, budget bars; Workflows with the stage rail,
artifact submission, and nested-run links; the approver Inbox (all approval kinds, one-click
decide); member Projects with shared context. (3) `/admin` rebuilt on the same system with a
real Cost & Projects dashboard (stat tiles, budget gauge, hand-rolled SVG showback/savings
charts). (4) Docker quickstart: Dockerfile + compose (Postgres + gateway + auto-migrate +
demo seed; keys in the container log) + README for both paths. The whole surface was driven
in a REAL headless-Chromium pass (sign-in, streamed reply, run auto-advanced to completion,
workflow rail, inbox approve, admin charts — zero page errors). (AWS deployment followed
the same day at the user's explicit request — see the entry above / ADR-0013.)

**Admin portal MVP, 2026-07-25 (ADR-0012).** One dependency-free HTML+JS file served by the
gateway at `GET /admin` — an auth-exempt STATIC SHELL (zero data, zero secrets; the admin
pastes an API key held in memory only) that is strictly a client of the public REST API, so
§5's policy-as-code parity holds by construction: the portal can be deleted without losing
any capability, and no state is UI-only. Tabs are §6's eight functional surfaces VERBATIM
(Users & Roles with the revocation/override layer, Agent Governance with enable toggles +
per-user entitlement views, Connector Governance, MCP Server Governance with the
auto-discovered tool inventory, Policy & Rules Engine over all three rule types, Audit &
Activity Log, the ONE Approvals Queue with inline decide, Simulation / Access preview over
/v1/evaluate) plus the §10.4-mandated Cost & Projects surface (budget-vs-actual + forecast +
showback + savings + compliance view per project). Gaps found while building were fixed as
API endpoints first (GET /v1/users, /v1/servers, /v1/servers/:id/tools, and the three
/v1/rules/* lists — all admin-gated). Deferred (per ADR-0012): SPA rewrite, SCIM/SSO status,
SIEM export, dry-run of UNSAVED policy, bulk actions, CSV export.

**Admin console restructure + roles as a full provisioning bundle, 2026-07-27 (ADR-0014,
migration 0030).** Two gaps closed on user feedback. (1) **Roles now grant agents + connectors**,
not just MCP tools/servers — new `role_agent_grants`/`role_connector_grants` tables (twins of the
per-user grant tables); the kernel folds role-derived grants in additively (`evaluateAgent`
direct-then-role with ceiling/mode still applied; `evaluateConnector` UNION-OF-GRANTS so a narrow
direct grant can't mask a broader role grant), wired into all six evaluate sites; endpoints
POST /v1/roles/:id/grants/{agents,connectors} + four-bucket read-back GET /v1/roles/:id/grants;
per-user revocation of role-derived agent/connector grants deferred (revocations are MCP-only).
ADR-0014 records the additive UNION-MAX semantics. (2) **The portal's flat 13-tab list became 6
grouped sections** (Identity & Access / AI Governance / Policy / Delivery / Cost / Operations); the
overloaded "Users & Roles" tab split into **Users / Roles / Teams**; deep-linking via
`location.hash` (reload keeps the page); the Roles page gained the **role-grants UI** (pick a role →
grant agents/connectors/MCP tools/servers → see the bundle) — the previously-missing "what does
this role grant" surface. UX pass (shared helpers): toast feedback replacing all alert()s +
submit-disable in `wire()`, confirm() on destructive actions, a mobile hamburger drawer (nav no
longer vanishes <900px), `field()` label/aria association, and a contrast bump. Verified on a fresh
DB (build + check-ui-syntax + gateway 297/297 + kernel 82/82) and a Playwright browser drive
(screenshots). Deferred UX follow-ups: table sorting/filter/pagination, human column labels,
raw-JSON operator views, full a11y/contrast sweep.

**Streaming dispatch, 2026-07-25.** Two layers, same gates. Provider layer: `dispatch()`
gains an `onText` delta callback; the Anthropic adapter uses the SDK's streaming API whenever
a caller wants deltas OR `maxTokens` exceeds 16k (long generations must not ride a single
request timeout), with `finalMessage()` returning the SAME complete result — accounting and
refusal handling identical to non-streaming (unit-tested against a faked Anthropic SSE body
through the injectable fetch: real SDK parse path, no network). The mock chunks its echo
deterministically so streaming is testable end-to-end. Gateway layer:
`/v1/agents/:id/invoke` accepts `stream: true` with `dispatch: true` — governance and routing
decide BEFORE any stream opens (denials remain plain JSON 403), then the response hijacks to
SSE: `delta` events as text arrives, one `result` event carrying exactly the JSON path's
payload, `error` events for post-headers failures. The audit row (flagged `stream: true`) and
measured usage ledger are written identically to the JSON path — streaming changes delivery,
never governance or accounting. Deferred: streaming for worker-node/auto dispatch (runs are
backend-driven, no client watching), multi-turn conversations.

**OpenAI model adapter, 2026-07-25 — the provider-agnostic principle made real at the model
layer.** `OpenAiProvider` in model-provider on the same playbook as the Anthropic adapter:
official `openai` SDK (v6) with injectable fetch, chat.completions with
`max_completion_tokens`, finish-reason mapping (stop/length/content_filter →
end_turn/max_tokens/refusal), `message.refusal` honored — a refusal's content is never
surfaced, matching the Anthropic discipline exactly — and streaming via `stream_options:
{include_usage: true}` feeding the same `onText` callback with the same complete-result
return. The registry now resolves anthropic + openai (apiKey required for both); google/xai
stay explicitly rejected. ZERO gateway changes were needed: credentials (platform + BYO-key),
routing, budgets, attribution, and streaming all already key off the provider string — the
e2e proves a `provider: "openai"` agent rides the whole governed pipeline against a local
fake chat.completions server (real adapter, correct Bearer key on the wire, measured usage
ledgered). **Google (Gemini) adapter, same day**: raw injectable
fetch — DELIBERATELY not the unified `@google/genai` SDK, which exposes no fetch injection
(untestable network code loses to plain REST; the git/pm adapters set the precedent) —
`generateContent`/`streamGenerateContent?alt=sse` with `x-goog-api-key` auth, incremental SSE
parsing feeding the same `onText` contract, finishReason mapping (STOP/MAX_TOKENS/SAFETY
family → end_turn/max_tokens/refusal) plus `promptFeedback.blockReason` → refusal (input
blocks and output filters both suppress content — same discipline). Registry now resolves
anthropic + openai + google; only xai stays rejected. Zero gateway changes again — e2e rides
a `provider: "google"` agent through the full pipeline against a local fake Gemini server
(correct header key + path on the wire, measured usage ledgered). **xAI adapter, same day — the registry is
complete.** Grok speaks OpenAI-compatible chat completions, so the chat-completions dispatch
core was extracted as a shared function (`dispatchChatCompletions`) and `XaiProvider` is that
core pointed at `https://api.x.ai/v1` by default — same contract, same refusal discipline,
same streaming accounting, provider-labeled errors. **All four real providers (anthropic,
openai, google, xai) + mock now resolve**; the "interface-ready but not implemented"
rejection era is over, and pillar 1's any-vendor routing claim is demonstrated across four
live adapters with zero gateway changes each time. Deferred: OpenAI Responses-API surface,
per-provider tool-use.

**Jira PM adapter, 2026-07-25 — pillar 8 grows its second real tool.** `JiraProvider` in
pm-provider: REST v2 deliberately (v3 forces ADF rich text; plain strings match the mapping
layer), Basic auth with the Jira Cloud `email:api-token` credential convention, injectable
fetch. The Jira-specific insight honored: **states are not settable fields** —
`transitionState` looks up the issue's available workflow transitions and executes the
matching one (by target-state or transition name), failing EXPLICIT with the available list
when the workflow offers no path (mirror failures surface, never fail the run event — the
established rule). `DEFAULT_MAPPINGS.jira` maps title→summary etc.; `blocked` is deliberately
unmapped (Jira's default workflow has no Blocked state — skip, never invent). Registry
resolves azure_devops + jira + mock; linear/asana/monday/generic_webhook stay rejected.
E2e: a run pm-syncs against a live-shaped fake Jira server (run parent + node issues created
with project/issuetype wrappers and Basic auth asserted on the wire) and a node_started event
mirrors through a real GET-transitions → POST-transition sequence. **Linear adapter, same day**: GraphQL-only API
handled natively — `LinearProvider` speaks `api.linear.app/graphql` (overridable) with the
raw api-key Authorization header, resolves the connection's `project` as a Linear TEAM KEY to
an id once (cached), and drives `issueCreate`/`issueUpdate`/`commentCreate`/`issue` queries;
GraphQL `errors` arrays surface as explicit PmProviderErrors. Transitions resolve the TEAM's
workflow states by name (explicit failure listing available states); Linear issues carry no
native type, so the interface's `type` is accepted-and-ignored (documented). Default mapping
maps title/description/priority with Linear's default state names; `blocked` unmapped again.
E2e: pm-sync + node_started mirror against a fake Linear GraphQL server (team resolution,
issueCreate inputs, raw-token auth, and the stateId move all asserted). **Asana adapter,
2026-07-25**: `AsanaProvider` speaks the REST API (`app.asana.com/api/1.0`, overridable,
Bearer PAT auth) with Asana's `{data: ...}` envelope on every request/response; `project` is
an Asana project GID and `type` is accepted-and-ignored (no native work-item types). Asana
has no workflow states — `transitionState` resolves the PROJECT's board sections by name
(exact then case-insensitive) and moves the task via `POST /sections/:gid/addTask`, failing
explicit with the available section list; the separate `completed` flag is deliberately
untouched (a section move is the literal board behaviour). `DEFAULT_MAPPINGS.asana` maps
title→name, status→section, description→notes; `priority` AND `blocked` both unmapped (no
native priority field, no default Blocked section — skip, never invent). getWorkItem reads
section-as-state for the matching project membership and filters stories to real comments.
E2e: pm-sync + node_started against a live-shaped fake Asana server (data envelopes, bearer
token, projects array, section lookup + addTask all asserted on the wire). **monday.com
adapter, same day**: GraphQL-only `MondayProvider` (`api.monday.com/v2`, overridable, raw
API token) surfacing HTTP errors, `errors[]`, AND monday's top-level `error_message` as
PmProviderErrors; `project` is a BOARD id, `type` accepted-and-ignored. Item URLs built as
`${boardUrl}/pulses/${id}` from a once-per-board cached board-url lookup. Transitions live
in the board's default Status COLUMN: settings_str labels parsed (cached per board), matched
exact-then-case-insensitive, applied via change_simple_column_value — explicit failure
listing available labels. `DEFAULT_MAPPINGS.monday` maps title→name, status→status with
statusMap in_progress→"Working on it", done→"Done", and — per-provider reality — blocked→
"Stuck" IS mapped (the default label ships); not_started/in_review/description/priority
deliberately unmapped. Registry: azure_devops + jira + linear + asana + monday + mock;
generic_webhook is now the SOLE rejected kind. E2e: pm-sync + node_started against a fake
monday GraphQL server (raw token, board_id/item_name, columns lookup + change_simple_column_
value with "Working on it" all asserted). **Generic webhook adapter, same day — the
pillar-8 matrix is COMPLETE; no provider kind is rejected anymore** (the registry switch
stays exhaustive so a future kind still forces a compile error). `GenericWebhookProvider`
inverts the vendor pattern: it POSTs RegulAIt's OWN normalized envelope `{event, timestamp,
project, payload}` (work_item.create/update/transition, comment.add, work_item.get — the
outbound mirror of ADR-0010's inbound shape) to a single customer-defined baseUrl (required,
used verbatim). The connection token is a shared secret used ONLY for signing —
`x-regulait-signature: sha256=<hex HMAC-SHA256 of the exact body>`; the token never travels.
Receiver contract: 2xx or explicit provider error; create must return a real {id, url}
(missing id fails explicit, links are never invented); work_item.get returns the item so
Sync-now verification works, and receivers without read-back fail loudly into the existing
orphan flow. `DEFAULT_MAPPINGS.generic_webhook` is the IDENTITY map over all five canonical
states including blocked — nothing invented because the vocabulary is ours. E2e: the fake
receiver verifies the HMAC on every request and asserts the token never travels raw.
**Compliance enforcement — PII mode + audit-retention pruning, 2026-07-26 (pillar 3 polish
1/4; no migration).** The cascade's last two "declared-not-enforced" dimensions become real.
New pure `packages/shared/src/pii.ts` `detectPII` (email / bounded SSN / Luhn-validated CC /
US phone — returns per-category COUNTS ONLY, never the matched substring, §8.4-safe). Wired
into the two PROJECT-ATTRIBUTED dispatch paths (executeGovernedDispatch + connector invoke;
MCP path honestly DEFERRED — it has no projectId): block on INPUT denies pre-call (no cost,
effect deny ruleId pii-blocked); block on OUTPUT bills-and-withholds (usage row written for
honest spend, outputText replaced by a withheld marker); warn proceeds + piiWarning + audit
pii-warned; log records category counts only. No-classification project = byte-identical
no-op. Audit-retention pruner: POST /v1/audit/prune (admin) deletes audit_log rows older than
a GLOBAL floor = max auditRetentionDays across all compliance profiles (longest-floor-wins,
audit_log has no projectId) + GET /v1/audit/retention shows the floor; the /compliance labels
honestly flipped (only claiming model+connector PII, mcp deferred). Suite 552 → 577.
Independently re-verified: build clean, shared pii 17/17, gateway pii e2e + mcp-proxy 158/158.
KNOWN LIMIT: streaming output-block can transiently flash raw text before the result event
overwrites with the withheld marker (input-block — the common vector — is airtight pre-call);
fast-follow = suppress streaming for block-mode projects.

**Pillar 3/4/5 polish batch complete, 2026-07-26 (4 slices, all stacked on PR #29).** Slice 1 =
the compliance-enforcement block just above (PII mode + audit-retention pruning, no migration).
Slice 2 (pillar-4 membership lifecycle, NO migration): PATCH/DELETE project members, owner-gated,
with hard last-owner protection (409); a provenance fix (context authorship now requires a real
authenticated user — bootstrap token 403s instead of being mis-attributed) and a write-race fix
(writeContextRevision read+insert wrapped in a transaction, 23505 caught+retried against the
existing (project,key,revision) unique index). Slice 3 (pillar-5 cost depth, migration 0028):
projects gain budget_period (none|monthly) + alert_threshold_pct + overage_approved_period —
calendar-month (UTC) windowed spend, overage latch scoped to the approved period key (clears on
rollover), non-blocking threshold alert below cap + hard block at 100%, CSV export
(/costs.csv + /usage-events?format=csv, RFC-4180, member-authz). Slice 4 (pillar-5 Initiative
object + cross-team rollups, migration 0029): new `initiatives` table — a FLAT, REPORTING-ONLY
grouping of projects (NOT a governance tier; no initiative-level budget/enforcement in v1) — plus
a nullable `projects.initiative_id` FK (onDelete set null: deleting an initiative orphans children
back to ungrouped, never deletes project rows). Admin-only CRUD /v1/initiatives (deliberately NOT
in NON_ADMIN_ROUTES — a rollup spans projects a non-admin may not be a member of), rolling up
child count + spend. /v1/projects/:id/costs gains a `byTeam` breakdown (spend attributed to the
team each member contributes under IN THIS project via project_members.teamId; null = "(no team)",
never fabricated) and the project's parent `initiative` label (so the member /app can show it
without the admin endpoint). Per-workflow cost_events source documented-as-reserved (comment,
no writer). Suite 552 → 597 across the batch. Each slice independently re-verified on a fresh DB
(build + check-ui-syntax + the relevant security-critical suites); slice 4 final: gateway 284/284
+ policy-kernel 71 + optimizer 31 + orchestration 23 + shared green. CI on PR #29 is
billing-cap-blocked (account-level Actions minutes cap: both jobs instant-fail, 404 logs, empty
output — verified not code); local verification is the gate. The AWS dev stack is on the
pre-polish merged-main build; a redeploy would be needed after PR #29 merges (only on request).

**§8.2 infrastructure-operations layer, 2026-07-26 — pillar 3's last unstarted surface lands
as a GOVERNED-operations layer (migration 0027).** Monitored resources + operational policies
+ inert findings + governed remediation — not a real patcher; a keyless MockInfraProvider
demos the whole detect→propose→approve→remediate spectrum. Migration 0027: infra_resources
(kind control_plane|agent_runtime|cert|backup_target, classifications), infra_policies
(patch cadence, cert-rotation window, backup schedule+retention, drift baseline,
auto_remediate_max_severity — enum low|medium|high, can't hold 'critical'), infra_findings
(drift|cve|cert_expiring|backup_missed × low|medium|high|critical, status open|
remediation_proposed|auto_remediated|remediated|accepted_risk; UNIQUE on
(resource,kind,detail.signature) so re-scan is idempotent); + approvals/audit_log objectType
+= 'infra_operation'; + compliance_profiles gains backup_retention_days + patch_cadence_days.
New packages/infra-provider mirrors connector-provider (scan/remediate interface, mock keyless
+ aws/azure/gcp 501). THE INVARIANT: a finding is an inert report; a remediation is governed.
On scan a finding is AUTO-remediated (no approval, still AUDITED ruleId infra-auto-remediate)
iff policy has an auto ceiling AND severity ≤ ceiling AND severity !== 'critical'; everything
else + ALL critical findings are approval-gated (approvals row objectType infra_operation via
__infra_remediation__ sentinel → the shared /decide txn → applyInfraApprovalDecision calls
provider.remediate on approve / accepted_risk on deny, both audited, all SoD guards for free).
Critical is doubly guarded (ceiling can't be 'critical' + explicit !=='critical'). §8.3
FINALLY ENFORCED: effectiveCompliancePolicy now composes backupRetentionDays (max) +
patchCadenceDays (min); a classified resource's backup floor = max(policy, cascade.backup,
cascade.auditRetentionDays) — consuming the formerly-dead auditRetentionDays — and its patch
ceiling = min(policy, cascade.patch); the /compliance endpoint's "declared-not-enforced"
labels honestly narrowed to only the still-unenforced parts. Admin Operations tab (resources/
policies/scan-now/findings-inbox/posture); app-ui infra approval label; seed 5 resources (one
HIPAA) + a scan producing the auto/open/critical mix. Suite 535 → 552 (10 provider unit + 7
e2e). Independently re-verified: build clean, infra-provider 10/10, infra e2e + mcp-proxy
157/157 (shared decide path regression-free).

**Pillar-1 rule scoping, 2026-07-26 — policy rules gain role/team/fleet scope (migration
0026); the "one row per user per server" gap closed.** All three restriction-rule tables
(approval_rules, rate_limits, data_scope_rules) were hard-bound to one user × one server
(NOT NULL FKs) — a fleet-wide "any write requires approval" was inexpressible. Migration 0026
(identical per table): user_id/server_id → nullable; add role_id/team_id (nullable FKs),
scope ('user'|'role'|'team'|'fleet', default 'user') + server_scope ('server'|'all', default
'server'); raw CHECK constraints enforce the discriminant; existing rows backfill to
scope='user'/server_scope='server' — byte-identical behaviour (all pre-existing single-user
rule tests pass unchanged). The gateway pre-filters rules in SQL by scope-membership —
`(fleet OR user=me OR role∈myRoles OR team∈myTeams) AND (all-servers OR server=this)`
(loadScopeMemberships resolves roleIds+teamIds) — exactly as role GRANTS are already
pre-filtered, keeping the kernel subject-free. THE INVARIANT (proven): all three rule types
run ONLY AFTER the untouched grant check, so a scoped rule can only ADD a deny/require_approval/
cap — it can never move default-deny to allow, and never relax another scope. Most-restrictive-
wins with NO cross-scope override (no exemptions in v1 — that would widen; deferred as a
separate explicit object): data-scope intersects all matching rules, rate-limits keep
independent per-subject counts (tightest denies first, no summing; all-servers rules count
across servers), approval pauses on any scope match. Guard test: a fleet/role restriction
never rescues an ungranted call. Admin Policy & Rules tab gains scope + server-scope selectors
with a swapping target select and legible "fleet"/"role: X"/"team: Y"/"all servers" listing;
seed shows a fleet approval rule + a role-scoped rate limit. Suite 524 → 535 (6 kernel unit +
5 e2e incl. the headline "fleet rule reaches a user with NO user-specific rule"). Independently
re-verified: build clean, policy-kernel 71/71, mcp-proxy 150/150.

**Connector execution layer, 2026-07-26 — pillar 5's connector-cost gap closed (migration
0025).** POST /v1/connectors/:id/invoke now really contacts the target system and meters cost.
New package `packages/connector-provider` mirrors pm-provider: CONNECTOR_PROVIDER_KINDS
(http/webhook/slack/github/jira/snowflake/generic/mock) + isConnectorProviderKind, neutral
`ConnectorProvider.invoke({operation,object?,payload?})→{status,body}`, injectable FetchLike,
GenericHttpConnectorProvider (read→GET, write→POST payload, optional bearer) + Webhook +
keyless MockConnectorProvider; registry exhaustive-switch, mock keyless, generic/http/webhook
need baseUrl, slack/github/jira/snowflake throw 501 (no silent promises). THE INVARIANT: one
allowed call = the existing ONE audit row + exactly ONE usage_events row; denied → 403 no bill,
failed upstream → 502 no bill (mirrors model path); execute+meter strictly inside the allow
branch. Flat pricing: pricePerCallUsd (null = unpriced → null cost, never invented). BACK-COMPAT:
a connector with null providerKind keeps today's governance-only behaviour exactly (decision +
audit, no execution, no cost) — nothing breaks until a connector opts in. Migration 0025:
connectors +provider_kind/base_url/price_per_call_usd (kind stays the free-text CATEGORY); new
connector_credentials (AES-256-GCM, platform-scoped, never returned); UNIFIED LEDGER —
usage_events token/model NOT NULLs relaxed + object_type ('agent' default, backfilled) +
connector_id + operation, so connector spend rides the SAME ledger and the project total +
showback-by-member pick it up automatically. Rollup gains byConnector (byAgent filtered to
object_type='agent', no phantoms); Spend page + per-project drill-down get a "Spend by connector"
card. Seed: snowflake-analytics now mock-kind $0.002/call (executes keyless) + 3 attributed
reads, jira-cloud stays governance-only. Suite 508 → 524 (8 provider unit + 8 e2e).
Independently re-verified: build clean, mcp-proxy 145/145, all 8 connector-execution e2e green,
migration applies on boot. Every governed entry point — model dispatch, MCP tool, connector —
now flows through the one attribution point.

**Team-Lead entitlement-narrowing tier, 2026-07-26 — pillar 7 §5.1 lands; pillar 7 complete
(no migration).** Worker nodes can declare a `leadNodeId` + `allowedAgentIds`/`allowedToolRefs`
delegation subset (ride the graph jsonb like the tool fields). The pure kernel helper
`computeNodeCeiling(graph, nodeId)` walks the lead chain UP and INTERSECTS each ancestor's
allow-sets (null = no constraint at that hop = identity; set∩set; empty = nothing) → a node's
transitive ceiling. policy-kernel: evaluateAgent gains ceilingAgentIds (new rule
`agent-lead-ceiling`), evaluate gains ceilingTools (new rule `lead-ceiling`) — consulted ONLY
on the allow path, so a ceiling can turn an allow into a deny but NEVER rescue an ungranted
call; default-deny preserved; a null ceiling adds no trace entry (flat runs byte-identical).
The INVARIANT (proven, not relabeled): effective = user_grants ∩ lead_chain_ceiling, composing
grandchild ≤ child ≤ lead ≤ initiating user — a worker is denied a tool/agent its INITIATING
USER genuinely holds because a lead excludes it, while a lead-less control node uses it fine.
Grants subject stays run.initiatingUserId at every site; the ceiling is a SEPARATE arg threaded
into evaluateNodeOwner (dispatch + reassign), planRun evalOwner (envelope + budget re-plan
candidate filter — a re-plan won't move a node onto a ceiling-forbidden agent), resolveNode
ToolContext (narrows what the model is even offered), and per-call executeGovernedToolCall (hard
enforcement). Distinct audit ruleId separates "narrowed by lead" from "user not granted" with
zero new logging. Decompose planner drafts optional two-level hierarchies (lead suggests subset,
gateway drops+records anything beyond the caller's own grants, human edits — the New Run editor
gained a per-node Lead select + allowed-agents/tools controls + indented hierarchy render);
mock `<<lead-plan>>` sentinel for keyless demo. Suite 485 → 508 (9 kernel unit + others).
Independently re-verified: build clean, policy-kernel 65/65, orchestration-tools e2e 9/9
including the narrowing cases. **Pillar 7 is now complete** — agents plan (decompose), do
tool-using work (governed loop), and delegate under enforced transitive entitlement ceilings.

**Tool-using multi-turn workers, 2026-07-26 — pillar 7's workers become a governed agentic
loop (no migration).** dispatchRunNode's single model call is now a bounded loop: each turn
one governed dispatch (measured usage row billed to run.projectId) with `tools` + accumulated
tool-history messages; when the model returns stopReason "tool_use", each tool call runs
through the SAME governance path as the MCP proxy — extracted as `executeGovernedToolCall`
(mcp-proxy.ts) and invoked AS run.initiatingUserId, one audit row each, so allow-list/
data-scope/rate-limit/approval self-enforce MID-LOOP across turns (rate limits are audit-log-
derived, so the Nth call is counted for free). Bounded by BOTH node.maxTurns (default 6, cap
20) AND the per-run measured budget checked EVERY turn — a runaway loop halts and escalates a
__budget__ approval into the one queue exactly like a single dispatch; an approval_required
tool breaks the loop leaving the node blocked, never hangs; no privilege increase entering
the loop. Provider contract extended additively (ModelToolDef in, "tool_use" stopReason +
toolCalls out, ModelChatMessage.content widened to text/tool_use/tool_result blocks; byte-
identical when tools absent) — Anthropic + OpenAI-family fully wired, Google best-effort. Mock
gains `<<use-tool:NAME>>` / `<<use-tool-loop:NAME>>` sentinels so the loop is testable keyless
against the real-upstream MCP harness. Node declares toolServers/toolNames/maxTurns in the
graph jsonb (kernel schema extended — NO migration; per-turn/tool trace rides the event jsonb
as node_tool_call). Decompose planning prompt lists the caller's entitled servers+tools so the
lead can assign them; New Run editor gains per-node tool-servers + max-turns controls. Suite
473 → 485 (7 unit + 5 e2e over the real upstream: granted-loop, ungranted-deny-mid-loop,
maxTurns cap, rate-limit-mid-loop, per-turn-budget halt+escalate). Independently re-verified:
build clean, mcp-proxy 137/137 green after the extraction. Deferred (unchanged): Team-Lead
TIER with transitive entitlement narrowing.

**Automatic context compaction, 2026-07-26 — pillar 6 §5 lands (first technique enabled by
the messages array).** Pure decision in optimizer-kernel (planCompaction/compactionSavings;
threshold >1600 est. tokens of model-bound history, last 4 messages always verbatim;
constants — per-user dials deferred pending an agent-policy migration home). Migration 0024:
summary/summary_through_message_id/summary_tokens/compacted_at on conversations — stored
messages NEVER deleted or altered (asserted). The summarizer is one governed dispatch to
the caller's cheapest entitled+dispatchable agent (audit purpose:"compact", billed to the
same project — the visible price of the savings); re-compaction is CUMULATIVE (prior
summary + newer turns, compacted-away turns never re-read); failure fails OPEN (audited
context-compaction-failed-open, full history dispatches, turn succeeds, failOpen in trace);
routingMode "passthrough" disables it (§12 off-switch consistency). Savings = max(0,
omitted − summary) tokens at the served agent's input price, recorded per summary-riding
dispatch under technique context_compaction in the SAME detail shape as model_routing — the
Spend page and admin charts lit up with zero chart changes. /app shows a compaction divider
with the expandable stored summary + badges + trace detail, persisted on replayed threads.
Suite 455 → 473; browser-verified (on-topic continuation through the summary, $0.0044
compaction bar beside model_routing, zero console errors).

**Prompt caching, 2026-07-27 — pillar 6's 4th technique (after routing, compaction, lazy
tool-loading).** NO migration — the `prompt_caching` cost_events enum value already existed.
Pure `planPromptCache` (optimizer-kernel): marks a stable system prefix cacheable once it clears
Anthropic's 1024-token minimum; passthrough is the §12 off switch; estimatedTokensSaved = the full
prefix served from cache per reuse; CACHE_READ_DISCOUNT 0.9 (ephemeral read ≈ 0.1× list, with the
first-call ~1.25× write surcharge acknowledged — the estimate is the labeled STEADY-STATE reuse
saving). model-provider gains an optional `cacheSystem` on the dispatch request: the Anthropic
adapter emits `system` as a text block carrying `cache_control:{type:ephemeral}` when set (plain
string otherwise, byte-identical); OpenAI/xAI/Google are documented no-ops (auto-cache / no
explicit breakpoint). Gateway writes ONE `prompt_caching` cost_events estimate when caching applies
and threads `cacheSystem` through the dispatch path — a pure cost annotation that never changes the
served agent/model/entitlement/budget/output (§12). The cacheable prefix is sourced from a new
optional `system` field on the invoke request body (the `agents` table has no system-prompt column
yet — a stored `agents.systemPrompt` column is the natural future home, deferred to avoid a
migration this slice). Suite 284 → 288 (prompt-caching.test.ts); optimizer 31 → 36, model-provider
57 → 60. No UI change (savings-by-technique chart is technique-generic). Remaining pillar-6
techniques: edit-vs-rewrite, file pre-processing, semantic caching, request batching.

**Edit-vs-rewrite, 2026-07-27 — pillar 6's 5th technique.** NO migration (the `edit_vs_rewrite`
cost_events enum value already existed). Pure kernel: `classifyEditIntent` (edit / rewrite /
unknown keyword heuristic — a REWRITE signal WINS when both appear, so a full rewrite is the safe
non-optimizing default and we never diff on an ambiguous ask) + `planEditVsRewrite` (guard order
mirrors planPromptCache: passthrough → no baseline → non-edit intent → baseline below the
200-token floor → else edit). When the request reads as a targeted edit over a large-enough
baseline, the gateway injects a compact-diff directive into the dispatch `system` and the
caller-supplied baseline (delimited) into the dispatch `input`, so the model returns a small diff
instead of re-emitting the whole file — the OUTPUT saving is real (not just accounting), the same
way prompt caching actually emits `cache_control`. Opt-in via a new `baseline` field on the invoke
body; baseline tokens are folded into the routing estimate BEFORE routeModel (the model must see
the file either way, so routing/budget/cost reflect the real payload); one `edit_vs_rewrite`
cost_events estimate is written, priced at the served agent's OUTPUT list price (saving ≈ baseline
× 0.75 output tokens). Pure cost annotation — never changes the served agent/model/entitlement/
budget/output; passthrough is the off switch. The baseline rides the model input for that one
dispatch only — persisted conversation history keeps the original request, so it never bloats or
re-sends. Suite 288 → 292 (edit-rewrite.test.ts); optimizer 36 → 47. No UI change. Remaining
pillar-6 techniques: file pre-processing, semantic caching, request batching.

**File preprocessing, 2026-07-27 — pillar 6's 6th technique.** NO migration (enum value existed).
Pure `preprocessReference` deterministically shrinks attached reference/file content without
changing meaning (collapse whitespace runs, trim, collapse 3+ blank lines, elide >512-char
base64/data blobs) while PRESERVING fenced code blocks verbatim (idempotent). `planFilePreprocessing`
decides whether to apply (passthrough off-switch; below a 200-token floor or a zero-reduction result
left untouched) and estimates INPUT tokens saved. Gateway: opt-in `referenceContent` invoke field;
reference tokens folded into the routing estimate at the ACTUAL sent size; processed content appended
as a delimited REFERENCE block (coexists with edit-vs-rewrite's baseline in the shared dispatchInput
composition); one file_preprocessing cost_events estimate at the served input price; persistTurns
keeps the original turn so the reference never bloats history. Suite 297 → 302; optimizer 47 → 59.
Remaining pillar-6: semantic caching + request batching (next slice, migration 0031).

**Semantic caching + request batching, 2026-07-27 — pillar 6's 7th & final techniques (migration
0031).** Semantic caching is a REAL opt-in per-(user,agent) exact-match response cache: an
identical (whitespace/case-normalized) single-turn re-ask within a 1h TTL is served straight from
the `semantic_cache` table, skipping the provider entirely — no usage_events, one `semantic_caching`
cost_events row for the whole-call saving. The lookup runs INSIDE the governance allow-gate and is
scoped by BOTH userId AND agentId (with a normalizedInput collision guard), so a user is never served
another user's — or another agent's — cached response (§12); misses store the result (refreshing the
TTL, never caching refusals/empty/PII-withheld). Request batching is an ESTIMATE only: on an
orchestration auto-pass with ≥2 ready nodes on the same model, one `request_batching` cost_events row
books the per-request overhead batching would amortize — dispatch is unchanged (true async
Batches-API batching doesn't fit the synchronous interactive path). Suite 302 → 307; optimizer 59 →
69. **All seven pillar-6 optimization techniques now shipped**: model routing, context compaction,
lazy tool-loading, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching (+ the
request-batching estimator).

**Admin console UX polish, 2026-07-27.** The deferred follow-ups from the console restructure:
`dataTable()` with free-text filter + keyboard-operable sortable headers (aria-sort, numeric-aware)
+ pagination (adopted on Users/Audit/Approvals/Projects/Findings); `humanizeKey` so th labels read
"Cost Center"/"Alert %" not camelCase; raw-JSON operator views replaced with formatted UI
(Simulation decision = effect badge + numbered rule chain, Compliance = badges + kv list, Infra
posture = inline counts, each with raw behind a `<details>`); and an a11y pass (focus-after-render on
the panel h1, nav aria-current, sortable-th keyboard, text badges for status not color-only, contrast
bump). Browser-verified (filter/sort/paginate on Audit, humanized headers, no console errors beyond
pre-auth 401s). This closes the "review the whole UI/UX" thread except the intentionally-open items
(nothing further deferred beyond what the deeper-a11y sweep would add).

**Pillar 7 — Team-Lead transitive per-node budget ceiling, 2026-07-30 (session-02 addendum 31, ADR-0016).** A mapping pass found the AGENT-entitlement narrowing already shipped (§5.1 lead ceiling: allowedAgentIds/toolRefs → computeNodeCeiling transitive intersection → policy kernel agent-lead-ceiling), so this slice built the missing BUDGET half. A task node gains `budgetCapUsd`; `computeNodeBudgetCeiling` folds the MIN of the node's own cap and every lead ancestor's — symmetric with the agent ceiling (delegation only ever TIGHTENS). Enforced at node_started on top of the run cap: a node over its ceiling escalates into the one Approvals Queue (node-budget-cap). No migration. Gateway 332 → 336, orchestration-kernel 23 → 27. Remaining in the sequence: pillar 3 infra-ops automation.

**AWS redeploy of PRs #34–#37 + a Docker-build fix + CI paused, 2026-07-30 (session-02 addendum
32, PR #38 merged).** The user asked to redeploy the merged work (chat multimodal, pillar-2
deploy/verify/rollback, pillar-3 BYOC, pillar-7 sub-budget) to the dev stack and to stop burning
CI. The redeploy SURFACED a real break: merged `main` did not build in Docker, because the image
runs `pnpm -r build` which type-checks the test files too (each package tsconfig `include:["src"]`)
and two test files that shipped via merged PRs carried type errors CI never caught — the account's
GitHub Actions minutes are exhausted, so every run instant-fails on a 404 log download before the
build gate ever runs. Fixed both (`model-provider/index.test.ts`: two block-array `dispatch()`
calls omitted the required-but-ignored `input` field + a null-narrow; `gateway/node-budget.test.ts`:
two inject helpers returned `app.inject(...)` un-awaited, yielding the overload-intersection type
without `.statusCode`/`.json` — awaited inside, matching sibling helpers). **CI paused** —
`.github/workflows/ci.yml` triggers switched to `workflow_dispatch` only (the `pull_request`/`push`
triggers kept commented for a one-line revert once minutes top up); local verification
(`pnpm -r build` + `check-ui-syntax` + `pnpm -r test`) is the gate meanwhile. PR #38 carries both
and is MERGED — `main` builds again. The dev stack was redeployed from the branch HEAD (= `main` +
those two commits, byte-identical app to post-merge main) because `main` itself didn't build until
#38 merged: `docker compose up -d --build` on `i-013c62adc887c76bb`, gateway container recreated,
the Postgres volume (pgdata) + per-boot secrets override preserved, migrations 0030–0033 applied
(`deploy_targets` present), `/app` + `/admin` 200 on-box at `http://3.237.199.248:3000`. Still
dev-grade, NOT production. The user then directed the four remaining open-item areas in parallel:
pillar-3 infra-ops AUTOMATION (drift/CVE/cert/backup — the operational half beyond the §8.2
governed-ops layer), clearing the ADR-0015/0016 + pillar-2 deferrals, and a deeper UX/a11y pass.

**Batch H SHIPPED — IDE interception is real, 2026-07-30 (migration 0037, ADR-0020).** The plan
below became code the same day, on the owner's "whatever is most comprehensive — need to give
options for the admins to choose from what to use on their end." Two provider-shaped
**translation shims** over the ONE governed dispatch core: `POST /v1/messages` (Anthropic shape,
also accepting `x-api-key`, so `ANTHROPIC_BASE_URL`-based tools like Claude Code just work) and
`POST /v1/chat/completions` (OpenAI shape, for Cursor/Cline/Roo/Continue/Zed), both with real
provider-native SSE. THE INVARIANT, tested against `/invoke` as a control: **the compat surface
creates NO privilege path** — an unentitled user is 403 on both, a revocation denies through them,
and an unresolvable model is 403 default-deny that writes ZERO usage rows, never a silent
pass-through to the vendor. Everything is an ADMIN CHOICE (migration 0037's singleton
`interception_settings`): which surfaces exist (`anthropic_compat_enabled` / `openai_compat_enabled`
default **FALSE**, `mcp_interception_enabled` default true and genuinely wired — false 404s the MCP
proxy too); `resolution_mode` (`map_by_model` | `require_agent` | `router_decides`, the owner's
decision that the admin picks rather than us); declared `enforcement_posture` (observe | voluntary |
managed | key_custody | network, driving honest honor-system warnings in the UI); and
`require_project_attribution`, the admin's lever to guarantee pillar-5 coverage by rejecting
unattributed calls. A disabled surface returns **404, not 501** — we never advertise something the
admin declined. New admin "Client Access" tab (Identity & Access) with a per-client config
generator built from `location.origin` and an honest coverage table naming Copilot and Eclipse as
NOT covered. Unsupported request fields **fail loudly with a 400 naming the field** rather than
being silently dropped (`temperature` included — `ModelDispatchRequest` cannot carry it, so real
clients that send it unconditionally will 400; documented). Streams open LAZILY so a PII-input
block or budget gate raised inside dispatch still returns a real HTTP error rather than a 200
carrying a failure. `docs/product/IDE_INTEGRATION.md` written. Gateway 386 → **426** (40 new).
**Honest limit, restated in ADR-0020:** this makes interception real but NOT universal — at the
`voluntary` rung it is an honor system, and `CLAUDE.md`/`VISION.md` still promise governance over
"every agent/model call" on the assumption calls arrive at us. Key custody is the cheapest
non-bypassable rung and is policy, not code. Those two files deliberately NOT edited — owner's text.

**PARALLEL WAVE LANDED — batches A, B-core, C-core, D-depth, E, org-settings, enterprise/UX,
2026-07-30→31 (PRs #48–#56, migrations 0038+0039, ADR-0021+0022; suite 432 → 492; deployed and
verified live).** The wave announced in the addendum below is COMPLETE. Six builder agents in
isolated worktrees + one hands-on UI review, merged sequentially by the dispatcher with a full
build+suite verification of each combined tree before any PR. Shipped: (A) GitLab/Bitbucket/
Azure-DevOps git adapters, refusals-over-approximations (#52, git-provider tests 7→51, plus an
additive `getPullRequest`/`listChecks` surface); (B-core) Slack/GitHub/Jira connectors (#49,
8→44; **Snowflake still open** — key-pair credential vs single-ciphertext schema decision);
(C-core) the real AWS infra adapter (#51, 33→83, injected clients, no fake success) + gateway
live wiring behind `REGULAIT_INFRA_LIVE` with `@aws-sdk/client-ssm/-acm/-backup` deps, flag-off
byte-identical (#55); (D-depth) OpenAI Responses API behind a behavior-preserving model list +
correct Gemini tool-use replacing the "best-effort" mapping (#50, 62→85); (E) the doc
reconciliation below + prepared-but-off CI + three Terraform follow-ups authored not applied
(#53). **Org-settings (migration 0038, ADR-0021, #54): the owner's standing configurability
mandate made real** — 37 admin controls (six optimizer technique toggles + dials wired to kernel
params that existed unwired; semantic-cache policy `off|opt_in|always`; `default_pii_mode` for
unclassified projects; env-key-fallback gate + visibility; budget `block|warn_only` + hard-block
pct; approval quorum `all|any`; retention auto-prune; worker caps; attachment/truncation
ceilings; `streaming_on_block_mode` + `strict_field_rejection` on interception_settings), every
default behavior-preserving, org = ceiling users can only narrow, new "Organization" admin tab
(Policy group). **Enterprise/UX (migration 0039, ADR-0022, #56): the UI review's three pilot
blockers closed** — approvers get a narrowly-scoped read of instances they are party to (driving
routes keep the strict gate) + merge-gate cards showing PR/checks/dry-run; full identity
lifecycle (deactivate with last-active-admin lockout, promote/demote, role holders/unassign/
delete, team member remove/delete, template retire, **approver delegation** with on-behalf-of
audit rows and an org kill switch); audit CSV export; all practicality gaps (inline confirms
replace native `confirm()`, names over UUIDs, copy buttons, live template resolution, thread
restore); #79b unimplemented-git-kind 400s at creation; #79c `dryRun` is structural, persisted
through the air-gapped branch, and **refuses production deploy gates**. UI review verdict
recorded honestly: past demo-ware, pilot-evaluation-ready; day-to-day operation still gated on
connecting real providers (model key = parked Batch G, owner's call) and the guided
first-provider journey (open). Wave-3 backlog, per ROADMAP §6: Snowflake credential schema,
worker streaming, `agents.systemPrompt`, `mcpDefaultMode` enforcement, O11/O13/O15 interception
depth, Azure/GCP infra, A4.

**Waves 7–8 addendum, 2026-08-01 — TLS, hardening, true SPA parity, username login, and a
terraform landmine (PRs #76–#84).** Written the same day, per the lesson recorded above.

- **#77 / ADR-0029 — zero-cost TLS.** Caddy in the compose stack, `3-237-199-248.sslip.io`
  (free wildcard DNS, no domain purchase), real Let's Encrypt certs. ALB+ACM declined on cost;
  self-signed rejected as not honestly "TLS". Cert volume is named (without it every redeploy
  re-issues and burns the rate limit); HSTS deliberately OFF on an IP-derived hostname; :80 must
  stay open or renewal fails silently two months later. **It exposed a real defect**: a reverse
  proxy would have made `req.ip` — on every `auth_sessions` row — record Caddy instead of the
  user, in a product whose first pillar is per-user audit. Fixed via `trustProxy`, safe because
  Caddy OVERWRITES X-Forwarded-For rather than appending.
- **#78 / migration 0047 / ADR-0030 — username login.** `@` is barred from usernames so the
  namespaces cannot overlap and a username can never impersonate an email; case-folding is
  enforced at STORAGE (normalize-on-write + CHECK), so `Dhruv`/`dhruv` cannot coexist even via
  hand-written SQL; the ADR-0025 uniform-401 body is preserved byte-identically and the unknown-
  username path still burns a scrypt. Seeded personas gained `admin`/`avery`/`dana`.
- **#79/#80/#83 — SPA parity was FALSE three times, then measured.** ADR-0026 claimed "parity
  proven, zero gaps". A capability diff found goal-decomposition, PM links and the decision
  ledger legacy-only (#79); investigating that found a FOURTH, pillar 4's shared context store
  (#80); and closing the last two end-user surfaces (#83) turned up a FIFTH class the diff is
  blind to — `byConnector`/`byMcpTool` spend was inside every project total but rendered in no
  breakdown. **Parity is now defined as a capability diff, not a nav walkthrough**, and the
  legacy shells were NOT deleted (the deletion was built, tested, then reverted).
- **#81 / ADR-0031 — P0 hardening** from an adversarial audit: streamed keyset CSV exports with
  microsecond-exact cursors (a naive cursor silently drops rows sharing an instant) and a
  DISCLOSED ceiling (a compliance export is never silently short); audit cursor pagination;
  `trustProxy` narrowed to Caddy's pinned address; rate limiting; CSP with boot-computed inline
  hashes; observable schedulers. It also corrected ADR-0029: forging `x-forwarded-proto: https`
  only turns Secure ON (harmless) — the dangerous direction, missed by me, is a forged `http`
  turning it OFF and issuing a cleartext-sendable cookie.
- **#84 — a terraform landmine, found before it fired.** `plan` proposed
  `aws_instance.app must be replaced` because the module read the AMI from
  `/aws/service/ami-amazon-linux-latest/...`, which AWS re-points on every AL2023 release.
  **Postgres is a container volume on that instance**, so any apply by anyone, for any reason,
  was total data loss. Fixed by pinning the AMI, `user_data_replace_on_change = false`, and
  reverting a cosmetic SG description (ForceNew). Plan now: `0 add, 2 change, 0 destroy`.

Suite 829 → **881**. Migrations → **0047**. ADRs → **0031**.

**NOT DEPLOYED as of this entry.** Today's app code is unshipped, and it cannot go out the old
way: #77 bound the gateway to host loopback, so a redeploy WITHOUT Caddy leaves the box
unreachable. TLS and the next deploy are one operation, and it awaits the owner's go-ahead.

**Standing exposure the owner has been told about twice and not yet acted on:** Postgres remains
a container volume on a single EC2 instance. #84 defused the current trigger; it did not remove
the exposure. Free mitigation offered: nightly `pg_dump` → S3 + a tested restore.

**Waves 4–7 addendum, 2026-07-31 — the work this file had NOT recorded (PRs #58–#75).**
Written 2026-07-31 to close the STATE.md drift noted at the top. Each item is in the session log
in more detail; this is the durable summary.
- **#58** worker/auto-dispatch STREAMING (multiplexed per-node SSE envelope, live Runs view,
  ledger parity streamed-vs-not).
- **#59** migration 0040 / ADR-0023: **Snowflake connector** (structured-JSON credential inside
  the single AES-GCM ciphertext — a zero-migration convention future multi-field connectors
  reuse), `agents.systemPrompt` (admin prompt is the dispatch system BASE, a caller's is APPENDED
  and can never replace it), and **`mcpDefaultMode` actually ENFORCED** (was declared-only).
- **#60/#62** Azure + GCP infra adapters and real azure/gcp/k8s deploy paths, with honest
  structural unknowns (Azure exposes no CVSS — the severity source is labeled; GCP has no
  renew-now cert API so rotation is a permanent 501).
- **#63** migration 0041 / ADR-0024 — **the interception trio**: every gateway call is now
  METERED (unattributed MCP lands in a visible NULL-project bucket, never a project budget),
  per-user/project/role **scope rules** for staged rollout (exposure ≠ entitlement, pinned by
  test), and **key custody is an ENFORCED rung** (BYO creds go inert), not merely declared.
- **#64** the **async-deploy refactor** (`DeployProvider` → Promise, awaited in workflows.ts, no
  lock held across a cloud LRO) plus the real AWS/Azure/GCP/k8s deploy clients it unblocked.
  `dryRun:false` only ever follows a genuinely completed call.
- **#65** guided **Getting-started** checklist from real readiness data (mock never ticks a box).
- **#67** compat long tail — `tool_choice`, structured outputs, Anthropic `thinking` honoured
  end-to-end; Anthropic `response_format` is a 400 rather than a fake emulation.
- **#68** migration 0042 / **ADR-0025 — SECURE HUMAN AUTH** (see the recap at the top).
- **#69/#70** **ADR-0026 — the React SPA**, phase 1 (workspace) then phase 2 (complete admin
  surface), with parity proven by 32/32 Playwright BEFORE the default-route swap.
- **#71** migrations 0043–0045 / ADR-0027 — all 11 remaining backlog items (per-kind deploy
  targets, A4 complete, cert lifecycle, backup scheduler, per-stage quorum, partial revocations,
  per-tool MCP pricing, additive-only reclassification reapply, per-framework cost policies, PM
  drift auto-resolution, PM budget mirroring).
- **#74/#75** two defects the OWNER found by using the deployed build: auth gates never named the
  account they were acting on; and an API-key session could be **locked out** by a
  forced-password-change gate demanding a password that was never issued. Fixed with migration
  0046 / ADR-0028 (`auth_sessions.origin`), scoped so the recovery bypass CANNOT be used to turn
  a stolen API key into a permanent password — that guard is a named test.

Suite 386 → **801**. Migrations 0036 → **0046**. ADRs 0019 → **0028** (0029/0030 in flight).
**Nine verified deploys.** ROADMAP §6's backlog went from 16 orphans to effectively empty.

**Standing owner directives as of 2026-07-31** — carry these forward:
- **Do NOT raise the Anthropic/model-key topic again until the owner raises it.**
- Admin-configurability is a standing mandate (ADR-0021 conventions).
- No production designation without explicit in-session sign-off (unchanged). The owner
  explicitly declined a production move and any new AWS cost on 2026-07-31.

**Housekeeping addendum, 2026-07-30 (doc-reconciliation batch — amends, does not rewrite, the
entries around it).** (1) **Temperature amendment to Batch H:** the entry above says unsupported
compat fields 400 loudly, `temperature` included. Amended the same day (`fdfeff1`, PR #47,
ADR-0020 §5): `temperature` is now **accepted-and-disclosed** — ignored, with the disclosure via
an `x-regulait-ignored-fields` response header plus an audit row — because real IDE clients send
it unconditionally and 400ing it defeated the very interception the batch exists for. All other
unsupported fields still 400 by name. (2) **Governance-gaps batch is MERGED** (PR #44, migration
0036, ADR-0019) — per-user revocation of role-derived grants, MCP attribution + PII, streaming
suppression for block-mode projects, and the `data_sensitivity` 6th assignment dimension; ROADMAP
§1 described it as in-flight. Current gateway suite after Batch H + governance-gaps + the
temperature merge: **432**. (3) **A parallel build wave is in flight** per the owner's directive
(batches A–D+C, the enterprise/UX track, and the admin-configurability mandate): org-settings
(claiming **migration 0038**) + git-provider adapters + connector adapters + infra AWS +
model-provider depth, each on its own branch. Migration coordination note: the next free
migration number is 0038 and org-settings is taking it — check `packages/db/migrations/` AND
`meta/_journal.json` before claiming a number, since the journal is what `migrate()` actually
reads.

**IDE / existing-agent interception identified as a SCOPE gap, 2026-07-30 (planning — the batch
above is the implementation; ROADMAP Batch H).** The owner raised that most developers use AI agents inside VS Code / Cursor /
JetBrains rather than through a governed portal, and RegulAIt never accounted for it. This is a hole
in the product thesis, not the backlog: every spec in `docs/product/` governs agents that come **to**
our gateway, so a developer running Copilot never touches it and the governance is invisible to
exactly the population it exists for. Findings: (a) **half already works, unmarketed** — the
streamable-HTTP MCP proxy (`POST /mcp/:serverId`) is a fully governed tool-call interception point
any MCP-capable IDE can use today with zero build; (b) **the gap is model calls** — there is no
provider-shaped endpoint (no `/v1/messages`, no `/v1/chat/completions`), only our proprietary
`/v1/agents/:id/invoke`, so IDE completions bypass attribution, optimization, PII and audit
entirely; (c) the fix is a translation shim over the existing `executeGovernedDispatch`, not a
second engine — the same zero-gateway-change shape that landed the OpenAI/Google/xAI adapters.
**Decision recorded (owner, 2026-07-30): model→agent resolution is an ADMIN-SELECTABLE POLICY, not
a constant** — `map_by_model` / `require_agent` / `router_decides` all ship and the admin picks,
bound by the invariant that an unresolvable model is **default-deny, never a silent pass-through to
the vendor**. Also recorded: the six-rung interception ladder (observe → voluntary → managed →
enforced), where **key custody** (the org holds vendor keys, developers hold only RegulAIt keys) is
the cheapest non-bypassable enforcement and is almost entirely policy rather than code. Becomes an
ADR when the batch is scheduled. Honest coverage note: base-URL override works for Continue/Cline/
Roo/Zed/Claude Code, Cursor takes OpenAI-compatible, **Copilot is largely locked down and Eclipse
has no first-party agent** — "works with every IDE" would be false. Doc debt flagged, not edited:
`CLAUDE.md`/`VISION.md` promise governance over "every agent/model call" on the assumption calls
arrive at us; adopting Batch H means restating that as an explicit interception story.

**Four-area cleanup batch shipped, 2026-07-30 (session-02 addendum 33; migrations 0034 + 0035;
ADR-0017, ADR-0018 + ADR-0015/0016 addenda; PRs #40/#41/#42, all merged).** The four directed
areas landed as three per-chunk PRs on fresh branches (branch-per-PR adopted this session so the
mobile app's PR chip tracks the current PR, not an old merged one). **(1) Pillar-3 infra-ops
automation (migration 0034, ADR-0017):** automation DEPTH on the existing §8.2 detect→remediate
spine — durable domain ledgers (`cert_inventory` + `cert_rotations`, `patch_records`
UNIQUE(resource,cve), `backup_runs`) that hang off `infra_resources` and link back to the inert
`infra_findings` via `ref_table`/`ref_id`; the pure detection math (`compareDrift`,
`cvssToSeverity`, `certSeverity`, `evaluateBackupSchedule`) extracted + unit-tested; governed
operator verbs (rotate / patch / restore) that flow through the ONE Approvals Queue via an
action-tagged sentinel `__infra_action__:<action>:<id>` — approve runs the provider action + writes
the ledger outcome in the same /decide txn, deny → linked finding `accepted_risk`; air-gapped
resources reuse the ADR-0015 boundary (metadata-only). `infra_resources.deploy_target_id` ties
customer-hosted resources to their BYOC target. No live cloud mutation. **(2) Deferral cleanup
(migration 0035, ADR-0018 + addenda):** azure/gcp/kubernetes deploy adapter SHAPES (dry-run + //
REAL: markers; all five kinds resolve); real @aws-sdk STS AssumeRole behind an off-by-default
`REGULAIT_DEPLOY_LIVE` flag (injectable client, fake in tests, no live mutation); admin Deploy
Targets management UI; MEASURED per-node budget running total (`measuredPerNodeUsd`,
`__nodebudget_measured__` escalation) + decompose auto-suggesting per-node caps + a per-node cap
chip in /app — clearing all three ADR-0016 deferrals; assignment matching gained target-system +
initiator-role dims (3→5 of 6 wired; data-sensitivity still deferred; `initiatorRole` server-
resolved, never client-supplied); seed now drives instances to rest at blocked_on_check /
blocked_on_deploy / rolled_back. A4 (per-mode policy + mode-aware audit retention) recorded as
design-only in the ADR-0015 addendum. **(3) Deeper UX/a11y:** shared render helpers hoisted into
`ui-theme.ts` (`UI_TABLE_JS`) so both UIs + every table reuse them; `table()` delegates to
`dataTable()` above 8 rows (the new Deploy Targets + infra cards inherit sort/filter/paginate free);
/app parity (renderDecision for the Playground trace, aria-live toast region, heading focus, mobile
hamburger, idChip sweep); a real WCAG contrast fix (`--text-faint` ~3.3:1 → ~4.9:1 + a `--decor`
token) + global :focus-visible rings + keyboard-copyable idChips. Verified per PR on a fresh DB
(build + check-ui-syntax + suites) — full gateway suite 345 → 361; UX PR added a headless-Chromium
drive (0 console errors, axe color-contrast serious+ = 0). CI stays paused; local verification was
the gate. Deploy note: also caught + fixed a pre-existing main build break (two test-file type
errors CI never saw while Actions minutes are exhausted) as part of the redeploy — see addendum 32.

**Pillar 3 — BYOC deploy targets: modes + AWS assume-role adapter + data boundary, 2026-07-28
(session-02 addendum 30, migration 0033, ADR-0015).** First pillar-3 slice, extending the pillar-2
deploy tail into customer-owned cloud. A deploy target gains a `mode` (hosted / byoc / air_gapped)
plus, for AWS BYOC, a `roleArn` + `region`. The `AwsDeployProvider` models STS AssumeRole into the
customer's role (short-lived creds, no static key) then deploy in their region — execution is a
deterministic **dry-run** (no real cloud call, no prod resource without explicit sign-off; `// REAL:`
markers show where the @aws-sdk calls go). The disclosed control-plane / agent-execution-plane data
boundary is **enforced in the executor by mode**: air_gapped keeps METADATA ONLY in the control
plane (never the deploy URL / provider detail), hosted/byoc keep the full record — a testable
property (air-gapped e2e asserts nothing crosses back), not prose. Gateway 327 → 332. Deferred: real
@aws-sdk execution, azure/gcp/k8s adapters, admin mode UI (ADR-0015).

**Pillar 2 — deploy → verify → auto-rollback, 2026-07-28 (session-02 addendum 29, migration
0032).** Completes the workflow pipeline's tail, on top of the check fail→route primitive. The
kernel gains executable `deployment` + `rollback` stages, a `blocked_on_deploy` manual-handoff
state, and a terminal `rolled_back`. A post-deploy verify is an `automated_check` with
`onFailure:"rollback"` that routes STRAIGHT to its rollback stage on failure (auto self-heal);
a rollback stage is a failure-only jump target that normal flow skips, so a passing deploy never
reverses itself. The deploy executor gates on a configured deploy target existing AND an optional
condition matching the change — either unmet parks at the manual handoff (resolved via
`POST .../deploy-override`); otherwise it deploys via a provider-agnostic adapter (mock now;
cloud adapters declared-not-integrated). Deploy targets are a new governed admin resource
(`deploy_targets`, creds encrypted at rest). The /app workflow detail surfaces the handoff, the
rolled_back terminal, and a Delivery row (live / rolled back). Gateway 322 → 327, kernel 29 → 33.
Next in the pillar sequence: pillar 3 BYOC/air-gapped deploy (real cloud adapters), pillar 7
orchestration depth, pillar 3 infra-ops.

**Pillar 2 — automated checks that FAIL and route, 2026-07-28 (session-02 addendum 28).** First
"workflow depth" slice after the 3-ask batch. Before this, every named automated_check auto-passed
— the pipeline had no failure path at all. Now a REPORTED failing check parks the instance at a new
`blocked_on_check` state (kernel: `check_failed`/`recheck` events + surfacing effect, guarded)
instead of advancing; a remediate-then-recheck loop resumes it. The gateway check executor resolves
each named check from reported results (`POST .../checks` — a real CI posts them, seed/tests too),
falling back to the deterministic auto-pass when none are reported (existing templates byte-
identical); a failure is audited `workflow:check_failed`. `POST .../recheck` re-runs a parked stage.
The /app workflow detail surfaces the block, per-check severity, "mark passing", and "Re-run checks".
No migration (free-text status; results in JSONB context). Gateway 318 → 322, kernel 26 → 29. This
is the failure primitive the conditional deploy + post-deploy rollback stages (next slice) build on.

**Chat→Claude + visual context graph + multimodal attachments, 2026-07-28 (three prioritized
product asks, see session-02 addendum 27).** (1) **Chat routes to Claude**: a platform API-key
ENV fallback (ANTHROPIC_API_KEY etc., last-resort after stored user/platform creds, read at
dispatch only) lets a self-hosted box go live with no admin-UI paste; a read-only
`GET /v1/model-providers/status` (booleans only) drives the composer's not-configured banner, and
a fresh chat now defaults to the highest-tier live non-mock agent (Claude wins ties). (2)
**Visual Context Graph** (pillar 4): new /app page rendering the shared-context store as a
dependency-free SVG version graph — one column per key, baseRevision→revision lineage edges,
conflict forks amber/dashed, click-for-detail with contributor/team provenance; backed by
`GET /v1/projects/:projectId/context/graph` (viewer-gated, 240-char preview). (3) **Multimodal
attachments** (mimics Claude native): 📎 + drag-drop + paste-image composer with a thumbnail/chip
tray (<= 8 files, <= 6 MB each) — images/PDFs ride the dispatch as base64 `attachments`
(`ModelContentBlock` gained image/document variants; Anthropic maps to native source blocks,
other adapters degrade to a named placeholder), text/code files ride `referenceContent`; history
stores only a named marker (never bytes, never re-billed), and attachments never widen
entitlement. Suite 307 → 318 (attachments.test.ts); model-provider 60 → 62. Browser-verified both
new surfaces, zero console errors.

**Agent-driven task decomposition, 2026-07-26 — pillar 7's headline lands, human-gated.**
`POST /v1/runs/decompose` {goal, projectId?, leadAgentId?}: a Team-Lead agent (leadAgentId ??
user default ?? cheapest granted mock, entitlement-checked under mode "plan") drafts a
task-graph PROPOSAL via one governed metered dispatch (policy → project budget gate →
usage/audit with detail.purpose:"decompose"; roster in the prompt = the caller's entitled
AND dispatchable agents with tier/price so suggestions are grounded). Parse (balanced-JSON,
fence-tolerant) → decompositionPlanSchema (2-8 kebab-id nodes) → agent names resolved
against real grants (unknown → default agent with recorded substitution) → the SAME kernel
validateGraph as planRun; one error-fed retry then honest 422 with rawOutput (both attempts
billed). It never creates a run — the proposal lands in the New Run editor (editable
everything, substitution badges, lead cost banner, "nothing runs until you accept") and
acceptance is the unchanged human plan gate. Mock planner: deterministic 4-node
analyze → two parallel goal-keyword middles → integrate, roster-aware, tier-scaled —
demoable with zero external keys. Suite 443 → 455; browser-verified (drafted plan executed
to completion with ∥ badges, zero console errors). Deferred (unchanged): Team-Lead TIER
with transitive entitlement narrowing, tool-using multi-turn workers.

**Multi-turn conversations, 2026-07-25 — the Playground stops being amnesiac (pillar 6
prerequisite unlocked).** `ModelDispatchRequest.messages` (full ordered history; `input`
ignored when present, byte-identical single-turn otherwise) threaded through all five
providers (google maps assistant→"model"; mock opens with a continuation line and terse
follow-ups inherit the previous turn's topic — demo-provable). Migration 0023:
`conversations` + `conversation_messages` (FK-free subject ids like the ledgers, cascade on
messages, assistant detail jsonb = stopReason/refusal/servedAgentId/modelUsed/costUsd/
credentialSource). Invoke accepts `conversationId`: ownership checked before anything bills;
EVERY turn is the unchanged governed pipeline (policy → routing → budget → audit → ledgers,
history growth added to cost estimates so budget gates stay truthful); transactional
persistence — success both turns, refusal flagged, denial user-turn-only (excluded from
future model-bound history), dispatch failure nothing. Own-scoped CRUD. /app Playground is
now two-pane: conversations rail (new/delete/active restore via sessionStorage), history
replayed through the SAME badge renderers as live turns (incl. denial pills), auto-create +
auto-title on first send, mid-thread agent/project switching. Seeded 2-exchange demo
conversation (idempotent, real-API-driven) + new seed.test.ts double-run suite. Suite
416 → 443. Browser-verified: continuation reply on-topic, reload restores thread, zero
console errors.

**Provider-native inbound webhooks, 2026-07-25 — the deferred ADR-0010 depth item.** New
`packages/pm-provider/src/inbound.ts`: per-provider `parseInboundWebhook` (exhaustive
registry) verifying each tool's REAL mechanism and translating its REAL payloads into the
one existing normalized shape — handshakes answered without processing, valid-but-irrelevant
payloads 200-and-dropped, verification failures → 401 with no secret material. Mechanisms:
linear `linear-signature` HMAC; asana two-phase (`x-hook-secret` echo handshake, then
`x-hook-signature` HMAC over thin state-less events resolved by read-through); monday
`{challenge}` echo + URL-token (monday sends no signature — documented limitation); jira
URL-token (Jira Cloud manual webhooks can't sign or set headers); azure_devops basic-auth
password; generic/mock `x-regulait-signature` HMAC (outbound symmetry) with the legacy
secret header still accepted, signature taking precedence. All comparisons constant-time.
Migration 0021 adds `pm_connections.webhook_secret_ciphertext` (AES-256-GCM, same envelope
as tokens) because HMAC needs the secret itself — the sha256 hash stays and still gates
legacy traffic. Raw-body capture is scoped to the webhook route only (encapsulated Fastify
scope; global JSON parsing untouched). Downstream normalized processing (pm_sync_events,
drift, orphans) unchanged. Suite 380 → 405 (20 unit + 5 e2e). **ADF descriptions for Jira, 2026-07-25 —
pillar 8's deferred list is now EMPTY.** New dependency-free `packages/pm-provider/src/adf.ts`:
`textToAdf` (paragraphs w/ hardBreak round-tripping, #-headings capped at 6, bullet/ordered
lists, code fences w/ language; total — never throws) and `adfToText` (inverse walk,
unknown nodes descended never dropped). `JiraAdapterOptions.apiVersion?: 2|3` (default 2,
zero behaviour change): v3 uses `/rest/api/3/`, converts the native description field and
comment bodies through ADF both ways. Migration 0022 adds nullable
`pm_connections.api_version` (null = v2; jira-only, superRefine-rejected loudly elsewhere);
admin form gains the v2/v3+ADF select. Adjacent fix: run pm-sync now seeds the mapped
description from the node's instruction at creation (initial value only — the PM tool owns
it thereafter per §3). Suite 405 → 416.

**EPIC-06 started — PM-tool integration first slice, 2026-07-25.** New
`packages/pm-provider` on the git-provider playbook (pillar 8, PM_TOOL_INTEGRATION_SPEC
§2/§3/§6): neutral `PmProvider` interface (create/update/transition/comment/getWorkItem), the
load-bearing FIELD MAPPING layer as pure zod-validated config with per-adapter defaults an
admin overrides (§7: never hardcoded), an Azure DevOps adapter (REST 7.x, PAT, injectable
fetch, json-patch), an in-memory mock, and a registry that explicitly rejects
jira/linear/asana/monday/generic_webhook until implemented. Migration 0013: `pm_connections`
(AES-256-GCM tokens like git_connections) + `pm_links` — the record that makes a task-graph
node BE a work item rather than a shadow copy; RegulAIt stores ONLY the linkage. §3 source of
truth honored literally: priority/description/acceptance-criteria are never cached — the links
view reads them through live (`?live=true`) from the PM tool. Status ownership (documented
decision, spec silent): RegulAIt owns node status (it owns the state machine) and mirrors it
OUTBOUND via the mapping's statusMap on every node event; unmapped statuses are skipped, never
invented; mirror failures are surfaced in the response, never fail the run event, never hidden.
Every creation/mirror writes the one audit trail (objectType "pm_work_item"). Endpoints:
PM connection CRUD (admin), `POST /v1/runs/:id/pm-sync` (idempotent node→work-item linking),
`GET /v1/pm/links` (+live read-through). **Second slice: §5 approval
mirroring.** Mapping gains an `approval` section (`target: status_transition|comment` +
per-stage `stageMap`); pure `resolveApprovalAction` degrades everything unmapped to a comment —
a sign-off decision is never silently dropped (§4's fallback rule applied to approvals), and a
DENIAL never enters a mapped state (always a comment — a customer's "Approved" state is only
entered on approve). Workflow instances now link to ONE work item
(`POST /v1/workflows/instances/:id/pm-sync`, idempotent), and the decide endpoint mirrors every
decided workflow sign-off and run escalation onto its linked item (transition and/or
`[RegulAIt] sign-off …` comment with decider + reason) — strictly display, never a second
decision point; a mirror failure is surfaced in the decide response and never unwinds the
decision. All mirrors audited (pm_work_item). **Third slice: §4 decision
records.** First-class `decisions` table (FK-free — governance records survive deletion;
decision-maker is ALWAYS the authenticated identity, never a body field) with
`POST/GET /v1/decisions` scoped to the parent run/instance initiator. Mapping gains a
`decision` section (customer's Decision-like work-item type + field paths for
title/rationale/decisionMaker); pure `resolveDecisionAction` mirrors a recorded decision as a
real linked work item of that type — with a §6 traceability comment on the parent item — or
degrades to a tagged comment when no type is mapped; no PM link at all = recorded locally with
no mirror. Never dropped, never blocking the local record. Run pm-sync now also creates a
run-LEVEL parent item (anchor for run-scoped records; unblocks budget-approval mirroring
later). **Fourth slice: inbound sync
(ADR-0010 — webhooks + live read-through, no polling).** Per-connection webhook secret minted
at creation (plaintext once, sha256 at rest, constant-time verify — API-key discipline);
`POST /v1/pm/webhooks/:connectionName` accepts the normalized
`{externalId, event: updated|deleted|commented, state?, fields?}` shape (provider-specific
payload translation is a later adapter concern; this shape doubles as the start of the generic
webhook adapter) and is the ONLY route exempt from bearer auth. Every signal lands in
append-only `pm_sync_events`, matched or not. Inbound state is recorded on the link
(`inboundState`/`inboundAt`) and NEVER applied to the state machine — divergence from the
mapped state of the node's current status surfaces as `drift` in the links view plus a
`pm-drift-detected` audit row ("never drift silently" = detect-and-surface, not
auto-overwrite); `deleted` events orphan the link, audited. Not in EPIC-06 yet:
budget-approval mirroring, provider-specific webhook payload adapters + HMAC signatures,
automated drift resolution (human today), Jira + remaining adapters.

**EPIC-05 started — multi-agent orchestration first slice, 2026-07-25.** New pure
`packages/orchestration-kernel` (pillar 7, MULTI_AGENT_ORCHESTRATION_SPEC §2–§5): task-graph
validation (zod + cycle detection + §4 ownership rule: nodes sharing files must be
dependency-ordered), ready-set scheduling with `parallelizable:false` serializing the whole run,
and a run state machine using the spec's five node statuses (not_started/in_progress/blocked/
in_review/done) with §3's three failure outcomes — retry, reassign, escalate — all event-driven.
**The task graph is input** (user/template-supplied): whether a PM Agent may generate it with a
model call is an open spec question, deliberately deferred until real model dispatch exists.
§5.1 (inheritance, never escalation) enforced at the gateway: every node owner — at plan time
AND on reassignment — goes through the same `evaluateAgent` under the *initiating user's*
grants/modes/ceiling; any deny rejects the whole plan (422) or the reassignment (403), audited.
Escalations land in the ONE approvals queue (`approvals.run_id` + objectType "run", named
approver from the graph; approve = re-open node, deny = abort run) and every run event writes to
the one audit trail (objectType "run"). Migration 0011: `orchestration_runs` (graph/state jsonb
snapshots, nullable workflow_instance_id for §8 build-stage nesting later),
`orchestration_run_events` (append-only), `approvals.run_id`. Endpoints: POST /v1/runs
(validate+plan, nothing executes until an explicit start), POST /v1/runs/:id/events,
per-run view (initiator-only) + admin fleet view. **Second slice: §5.2 per-run budget caps.** Pure `estimateGraphCost`/`estimateNodeCost` in the
orchestration kernel (per-node token estimates — planner-declared or heuristic — × the owner
agent's list price; an unpriced owner nullifies the total, which fails CLOSED under a cap:
a cap that can't be checked requires approval, never silent skip, §7). Cap + breach action
(`approve`|`replan`) are admin-set on `user_agent_policies` — an explicit stand-in for the
per-project budget until a projects entity exists. Three §5.2 enforcement points, all
estimate-based (labeled as such in every payload) until real dispatch exists: (1) pre-execution
— over-cap plans either auto-re-plan (owners substituted per node via pillar 6's `routeModel`
with cost-sensitive bias over the entitlement-filtered candidate set — re-plan can never
escalate; substitutions ledgered as `cost_events` objectType "run") or gate `start` behind a
`__budget__` approval; (2) in-flight — `spentUsd` accumulates per node start, and a node whose
CURRENT owner (e.g. after reassignment to a pricier entitled agent) would breach the cap is
paused with a `__budget__:<node>` approval; (3) decisions — approve lifts cap enforcement for
that run (sanctioned overage, audited), deny aborts. Still not in EPIC-05: real worker dispatch,
PM-agent decomposition, team-lead tier, workflow build-stage nesting, per-project budgets.

**EPIC-04 started — token/cost optimization first slice, 2026-07-25.** New pure
`packages/optimizer-kernel` (pillar 6, TOKEN_OPTIMIZATION_SPEC §7/§8): deterministic complexity
classifier (never an LLM call — no text = no signal = no downgrade), token estimator, and
`routeModel()` — cheapest-eligible model selection with a relative tier floor per complexity,
§9 cost-sensitivity biasing (quality-sensitive = never downgraded), a §12 per-user passthrough
off switch, and full `{effect, ruleId, ruleChain, reason}` traceability. Routing runs strictly
*inside* governance at the same interception point: the candidate set is exactly the agents
`evaluateAgent` allows for that user+mode (re-enforced against the tier ceiling in the kernel as
defense in depth), so the optimizer can never widen entitlement. Savings semantics kept honest:
routing reports cost-saved (same tokens, cheaper model) against an explicit
`estimationBasis` — the counterfactual is the requested (baseline) model at list price; tokens-
saved stays 0 and is reserved for future compaction/dedup techniques. Migration 0010:
`agents.cost_per_mtok_in/out` (list price; unpriced models are never routing targets),
`user_agent_policies.routing_mode`, and the FK-free `cost_events` savings ledger (one row per
routing decision, per-technique enum covering all six §7 savings sources). `GET /v1/cost-events`
(admin fleet-wide, non-admins forced to self) returns raw events + per-technique totals —
the dashboard-ready §7 emitter that pillar 5's per-project rollup will consume. **Second slice
(same day): lazy tool-loading in the MCP proxy (§8)** — an optional `?intent=` on the proxy URL
(MCP's tools/list handshake carries no request text, so the signal rides on the URL) feeds pure
`selectTools()`: lexical relevance scoring narrows the *entitled* manifest to intent-relevant
tools, withheld tools stay fully callable (tools/call never consults the selection — the
manifest shrinks, the entitlement never does), no intent or zero matches fails open to the full
entitled list, the same per-user `routing_mode` passthrough switch disables it, and each
tools/list writes a `lazy_tool_loading` cost event with tokens-saved measured from the actual
serialized manifest chars withheld. **Third slice: §9 cost-sensitivity tag on workflow
templates** — `costSensitivity: cost-sensitive|standard|quality-sensitive` on the workflow
definition (validated by the kernel, no new stage type, no migration — it rides the definition
jsonb into the instance snapshot), merged strictest-wins in `mergeDefinitions` (an untagged
template counts as "standard", so a merge can never inherit cost-sensitive downgrading from
one team's template), surfaced top-level on the per-instance view. The invoke path has accepted
the same enum since slice 1; wiring instance→invoke happens when workflows actually invoke
models. Not in EPIC-04 yet: edit-vs-rewrite, compaction, file pre-processing, prompt/semantic
caching, batching.

**EPIC-03 started — workflow engine first slice (PR #9).** New pure `packages/workflow-kernel`:
declarative template validation (§3 — executable stage types trigger/planning/
artifact_generation/human_approval/automated_build/automated_check; git_operation/deployment/
rollback rejected until integrations exist), §4 assignment-rule matching (path glob/changeType/
environment, ANDed; multi-template union-merge keeping every approval stage, single trigger),
and a pure instance state machine: versioned sign-off (§2 stage 4 — artifact edits after
approval re-open the gate and supersede stale pending approvals), decide≠execute (build/check
stages await an explicit human trigger), denial/abort terminal states. Gateway: migration 0007
widens `approvals` into the ONE §6 inbox (workflow sign-offs are approvals rows with
object_type/instance_id/stage_id; deciding one advances the instance, all-named-approvers-must-
approve), plus `workflow_templates`/`workflow_assignment_rules`/`workflow_instances` (merged
definition snapshotted at start)/`workflow_events` (append-only history)/`workflow_artifacts`
(every version retained). Endpoints: template/rule CRUD (admin), instance start (auto-advances
to first block; §4: requester doesn't pick the workflow — rules do; explicit template =
admin-only), artifact submit/edit, advance, abort, per-instance dashboard view + admin fleet
view. Everything audits into the one trail (objectType `workflow`).

**§5 review fixes + agents/connectors governance (PR #8).** The PR #7 adversarial-review
findings are fixed: revocations are unique per (user, server, tool) with NULLS NOT DISTINCT
(migration 0005, duplicates deduped), Postgres constraint violations map to 409/400 instead of
500, and the entitlements view now surfaces tool-scoped carve-outs of role read-only-all grants
plus a `GET /v1/revocations` listing. Governance then extended to two more §2 object types
(migration 0006): **agents** — global registry (name/provider/tier/modes/enabled, §4), per-user
grants with mode-level restriction, per-user default+ceiling policy (tier-based), and a governed
`POST /v1/agents/:id/invoke` enforcement point (registry-enabled → allow-list → mode → ceiling →
allow, deny-by-default); **connectors** — catalog, per-user grants with read/readwrite mode and
`allowedObjects` data scope (fail-closed), governed `POST /v1/connectors/:id/invoke`. Both audit
into the **same** audit_log, widened with object_type/object_id/detail (§7's one audit trail).
Actual provider routing attaches to the invoke endpoints later — governance precedes routing.

**Roles + per-user overrides landed (PR #7) — §5 for the MCP object type.** Kernel: role-derived
grants (`RoleToolGrant`/`RoleServerGrant`, pre-filtered by the gateway to assigned roles) and
`Revocation` (subtractive per-user override; toolName null = all role-derived access on the
server). Precedence: direct grants > revocations > role-derived > default-deny — a revocation
never suppresses a direct grant, and revoked role grants trace as `revoked` (with the revocation
id) in the audit ruleChain. Gateway: migration 0004 (`roles`, `role_tool_grants`,
`role_server_grants`, `role_assignments`, `revocations`), role CRUD + assignment endpoints,
revocation create/delete (independently reversible per spec), and a per-user×server
**entitlements view** flagging every entitlement's source (direct vs role name) and any
revocation — §5's "override visibly flagged as a deviation", API-level.

**Real authn landed (PR #6) — the pre-ship blocker is closed.** Per-user API keys (`rgl_` +
24 random bytes, only the sha256 hash stored, shown once at creation, revocable, lastUsedAt
tracked), `users.isAdmin` flag, and a deploy-time `REGULAIT_BOOTSTRAP_TOKEN` (admin with no
user identity — exists only to mint the first real admin; cannot call tools or decide
approvals). Every gateway route now requires a valid Bearer token; everything is admin-only
except approvals-decide (named approver), own-visible-tools, and the MCP proxy (any user key).
The proxy's trusted `x-regulait-user-id` header is gone — identity comes from the key. The
approvals decide endpoint derives the decider from the authenticated identity (the old
body-supplied `deciderUserId` was spoofable). Migration 0003 (`api_keys`, `users.is_admin`).

**Data-scope rules landed (PR #5) — §3 feature-complete for the MCP object type.** Kernel:
`DataScopeRule` input (per-user×server, optional tool scope, dot-path into call arguments,
allowed-values list) — all matching rules must pass (AND), missing/non-scalar values fail
closed, violations deny before rate limits or approvals are consulted (order: grants →
default-deny → data-scope → rate-limit → approval → allow). Gateway: `data_scope_rules` table
(migration 0002), `POST /v1/rules/data-scopes`, and the proxy now passes each call's arguments
into `governedEvaluate` so scope is enforced on real MCP traffic.

**Approvals + rate limits landed (PR #4)**: the kernel now returns a third effect,
`require_approval`, and takes approval rules (per-user×server, optional tool scope, optional
write-only, named approver) and rate limits (per-user×server, optional tool scope, caller-supplied
usage counts — kernel stays zero-I/O) as inputs. Rule order: grants → default-deny (nothing
rescues an ungranted call) → rate limits (exhausted limit denies even with an approval in hand) →
approval rules → allow. Gateway: `approval_rules`/`rate_limits`/`approvals` tables (migration
0001), §6 Approvals Queue endpoints (`GET /v1/approvals`, `POST /v1/approvals/:id/decide` —
named-approver-only, 403 otherwise), rule CRUD, and proxy `tools/call` enforcement: paused calls
create/reuse one pending queue entry; approved entries are consumed atomically by exactly one
retried call (single-use); usage counting = audit-log allow rows in the limit's window.

**Session 02 continued**: CI added (`.github/workflows/ci.yml` — build + all tests on every
PR/main push against a Postgres 16 service container; PR #2, merged). Then the **real MCP proxy
path** landed (PR #3): `POST /mcp/:serverId` speaks streamable-HTTP MCP on both sides via
`@modelcontextprotocol/sdk` v1.29 (gateway = MCP server to clients, MCP client to upstream) —
`tools/list` auto-syncs the upstream tool manifest into `mcp_tools` (kind inferred from
`annotations.readOnlyHint`, defaulting to write) and filters through `visibleTools()`;
`tools/call` runs the kernel, audits every decision, and only forwards allows upstream. User
identity is an interim trusted header (`x-regulait-user-id`) until real authn lands. E2E-tested
with a real in-process upstream MCP server and real MCP client (26 tests total).

### Wave 9 addendum (2026-08-01) — infra applied, HTTPS live, CI back, power schedule

The owner asked for six things in one message: apply the infra, start powering the AWS box off
when idle, deploy the latest app code, re-enable CI within a 2,000 min/month allowance, clean up
the legacy UI, and get HTTPS live. All are done or in flight, and the route there surfaced three
real defects that had been latent precisely because nothing was exercising them.

**Infra applied (#84's plan, verified `0 add / 2 change / 0 destroy`).** Ports 80/443 opened, the
`:3000` ingress removed. No instance replacement, so the Postgres volume (`vol-0573958930d696417`)
survived — that was the whole point of the #84 landmine fix. **But the apply changed `user_data`,
which the EC2 provider applies by STOPPING AND STARTING the instance**, which released the
auto-assigned public IPv4. The address moved `3.237.199.248` → `98.86.163.252`, and later again to
`3.229.246.126` on Elastic-IP attachment. Worth internalising: *any* `user_data` edit is an
address change on a box whose hostname is derived from its address.

**Defect 1 — the `tls` profile had never once started.** It shipped in #77 and was never exercised
end-to-end. Caddy pins itself to `172.28.0.2` so `REGULAIT_TRUSTED_PROXIES` can name exactly one
container (ADR-0031), but **pinning an address does not reserve it**: Docker allocates dynamically
from the start of the subnet, and Caddy is necessarily last to start (gateway waits on db's
healthcheck, Caddy waits on the gateway). `db` took `172.28.0.2` and Caddy died with
`Address already in use` — which reads as a host *port* conflict, not an IPAM one, with nothing
listening on 80 or 443. Since the gateway is loopback-only since ADR-0029, this left the box with
**no route in at all**. Fixed in #88 with an explicit `ip_range: 172.28.1.0/24` confining dynamic
allocation clear of the pinned address.

**HTTPS is live and verified** (#88 + deploy): Let's Encrypt `CN=3-229-246-126.sslip.io`, `/`→302,
`/ui`→200, `/health`→200, port 80→308 redirect, chain validates. Deploys preserve
`REGULAIT_DATA_KEY` — regenerating it would make every stored credential permanently undecryptable.

**Defect 2 — CI's first run caught a latent test bug.** All **881 tests passed** and the job still
exited 1: `seed.test.ts` tears its scratch database down with `DROP DATABASE ... WITH (FORCE)`,
which force-terminates a connection something still holds, raising Postgres `57P01` as an
unhandled pool error that vitest counts. Latent for weeks *because CI was off*, and it would
red-fail every PR. Being fixed properly rather than suppressed.

**Defect 3 — ADR-0032's `aws:SourceArn` confused-deputy guard does not work** (#90). Every
`CreateSchedule` failed with an error that reads exactly like IAM propagation lag and is not — it
survived four applies over ~30 minutes. Bisected against live API calls: `SourceAccount` alone
passes; `ArnLike` fails; **`ArnLikeIfExists` also fails**, even though tolerating an absent context
key is precisely what that suffix exists for. `CreateSchedule` validates the trust relationship
*before the schedule exists* and satisfies no `SourceArn` condition in any form. Guard dropped,
with the cost stated plainly in the ADR: cross-account is still blocked, intra-account narrowing is
not, and the compensating control is the permission policy (exactly Start/StopInstances on exactly
the passed instance ARNs, no Terminate, no wildcard). **A trap for anyone re-testing: the
validation verdict is cached per-role for a minute or two, so back-to-back probes return the
previous policy's answer.** Two intermediate readings were initially misread that way.

**Power schedule live** (ADR-0032, #87/#90): EventBridge Scheduler → EC2 universal target, no
Lambda and nothing always-on. `ENABLED | start=cron(0 8 ? * MON-FRI *) | stop=cron(0 20 ? * MON-FRI *)
| tz=America/New_York`. **≈$20.43 → ≈$10.67/mo (~48%)** — honestly not more, because EBS bills
whether the box runs or not and the IPv4 charge applies idle or in use; only compute scales with
uptime. `infra/scripts/boot-resync.sh` is installed as a systemd oneshot and re-points Caddy on
every boot; on first run it also re-enabled swap and wrote the `/etc/fstab` entry user-data never
did (cloud-init `scripts-user` is per-*instance*, never per-boot).

**CI re-enabled on a budget** (#86). GitHub bills per job, wall-clock, rounded up, and parallel
jobs bill separately. So: no `push: main` trigger (a PR run already builds the merge commit, so it
was pure duplication), a weekly `schedule` covering what PR runs structurally cannot, docs-only
changes skipped entirely, and `docker-build` self-skipping unless an image-relevant file moved —
**that gate already proved out, finishing in 4 seconds instead of ~5 minutes**. Estimated headroom
~215 PR pushes/month.

**Legacy UI deletion — blocked twice, correctly, then unblocked.** The first attempt was reverted
(`95a3bc1`) because ADR-0026 *asserted* parity with zero evidence and five capabilities were
legacy-only. A rigorous capability diff this session found **six more**: rules deploy-mode scoping,
revocation narrowing, and four run-detail operator controls (manual node dispatch, `reassign_node`,
`node_submitted`, per-node instruction override) — meaning the SPA could only drive a run fully
automatically and could not rescue a stranded node. Closed in #89, which also promoted the checker
into the repo as `scripts/parity-diff.mjs` + `legacy-ui-parity.test.ts`, comparing **three**
dimensions (endpoint shapes, run event kinds POSTed, request-body keys) because an endpoint list
alone cannot see gaps 4–6. It also found the throwaway extractor's comment stripper would eat the
rest of a file on a `text/*` literal — i.e. **it could report false parity**. Deletion follows.

**Legacy UI deleted (ADR-0033, #93) — −7,125 lines.** `admin-portal.ts` (2,583), `app-ui.ts`
(2,841), `ui-theme.ts` (927), plus `check-ui-syntax.mjs`, the `/legacy/*` routes and the tests
that existed only to assert the deleted shells. The parity checker was run on `main` immediately
before deleting and reported zero legacy-only endpoints, run event kinds and request-body keys;
that output is ADR-0033's evidence. Test count 1592 → 1585, and **every one of the seven is an
accounted-for legacy test** — two suites had a legacy assertion *replaced* rather than removed, so
`/legacy/*` is now positively asserted to be gone (401 → 404, never HTML) instead of merely
untested.

Three judgement calls in that PR are worth keeping: **CSP was not weakened** (the inline-script
hashing is shared with the SPA's theme pre-paint script and stays); **`style-src 'unsafe-inline'`
was deliberately left alone** even though ADR-0031's blocker for it is now gone, because a wrongly
tightened `style-src` renders an unstyled page rather than raising an error and needs its own
browser verification; and **the parity gate was deleted along with the thing it guarded**, since
freezing it against a snapshot of a deleted file yields a gate that can only ever pass — worse
than no gate, because it looks like protection. The method it encoded is written into ADR-0033 §1
and the script is recoverable at `a8d2ce9`.

**Standing lesson, restated:** every one of these three defects existed because something shipped
without ever being executed in its real environment — a compose profile never started, a test
suite never run by CI, an IAM policy never applied. Green local tests are not evidence that a
deployment path works.

### Waves 10-11 addendum (2026-08-01) — bring-your-own LLM, and the security work it exposed

The owner asked to "add the ability for users to plug in their own LLM", then for four follow-ups
in sequence. Seven PRs (#95-#101). The feature itself is the smaller half of the story.

**Custom LLM providers (ADR-0034, migration 0048, #95/#97).** BYO *keys* already worked; what did
not exist was a way to name an endpoint the platform ships no adapter for — `provider` was a closed
zod enum of four internet SaaS vendors, so Ollama, vLLM, LM Studio, Azure OpenAI, a Bedrock proxy
and every internal gateway were unreachable, and `agents` had no per-agent endpoint so two
self-hosted models on two hosts was inexpressible. **This also made pillar 3's air-gapped mode
hollow** — a mode whose every supported provider is an internet SaaS is not an air-gapped mode.
Admin-only registration; agents bind by FK (`agents.custom_provider_id` + a DB CHECK making
`provider='custom'` a real discriminated union) rather than by smuggling an id through the
`provider` text column that `model_credentials` keys on and an exhaustive switch depends on. The
adapter implements no protocol of its own — `openai_chat` IS the shared chat-completions core,
`anthropic_messages` IS `AnthropicProvider` — so streaming, refusals and usage accounting are
inherited by construction. Keyless endpoints (local Ollama) are first class: the `Authorization`
header is DELETED, not filled with a sentinel.

**The headline is not the feature. An admin-suppliable `baseUrl` is an SSRF primitive**, and on EC2
it reads the instance role's IAM credentials out of `169.254.169.254`. Building the guard for the
new surface exposed that the *old* ones were never guarded — and worse than first disclosed:
`POST /v1/users/:userId/model-credentials` is in **`NON_ADMIN_ROUTES`**, and a per-user credential
takes **precedence** at dispatch. **Any authenticated user could read this box's AWS credentials.**
Live since per-user BYO keys shipped (migrations 0016/0017). Closed in #96.

**Then the same shape everywhere else (#98).** `connectors.baseUrl` was the sharp one: the
`webhook` kind (and PM's `generic_webhook`) **POSTs the caller's payload** to the URL, so it was an
**exfiltration** channel, not merely SSRF — a governed, audited, cost-attributed pipe to an
attacker's collector. Proven closed by *absence*: a live, listening collector on un-allow-listed
loopback receives **zero requests** and never sees the canary.

**The DNS-rebind window, closed at last (#100).** Three PRs had each disclosed and left it:
validate, then let Node resolve the name a second time at connect. `pinned-fetch.ts` connects
through a `lookup` that resolves nothing and returns the addresses just validated. **The
dependency question was answered NO NEW DEPENDENCY** — Node 22 exports no `undici`/`Agent`, and
both routes to one (a direct dep = a second HTTP stack in the security path; or the undocumented
`globalThis[Symbol.for("undici.globalDispatcher.1")]`) fail the posture `ci.yml` already applies to
third-party actions. `http.request`'s documented `lookup` option gives the whole capability from
stdlib for ~300 lines. **The test performs the attack**: two real TLS listeners on 127.0.0.1 and
127.0.0.2, resolver answering benign-then-attacker; unpinned, the socket lands on the attacker
(asserted on `res.socket.remoteAddress`); pinned, the attacker records zero connections and the
resolver is called exactly once.

**HSTS (#101).** Caddy abstained with a long comment explaining why; the gateway asserted
`max-age=31536000; includeSubDomains` anyway. Two layers disagreeing about a **non-revocable**
browser commitment was the defect. Gateway now owns it (it is what ships into BYOC installs where
no Caddy of ours exists), default `max-age=86400`, no `includeSubDomains`, no `preload`,
configurable via `REGULAIT_HSTS` — deliberately an env var and NOT `org_settings`, because it is a
deployment-shape fact, it is the one setting a server cannot undo, and it is read in the `onSend`
hook that must work when Postgres is down. **ADR-0029's own reasoning was corrected**: its claim
that `includeSubDomains` would be "hostile to everyone else using sslip.io" was overstated — HSTS
is host-scoped. The real argument is better: a released Elastic IP returns to the AWS pool, so a
stranger could inherit our hostname *and* any pin left in browsers.

**Backup: merged, NOT running (ADR-0035, #99).** Nightly verified `pg_dump` to a write-only,
versioned S3 bucket the instance can `PutObject` to but **cannot read or delete**. Restore was
**exercised, not documented** — 70/70 tables matched, scrypt hashes and audit rows byte-identical.
A measured finding worth keeping: on a 90%-truncated dump `pg_restore --list` **exits 0** while an
actual restore yields **0 of 200,000 rows**, so the obvious `--list` check would have blessed and
uploaded a backup containing none of the data. **This is inert until `terraform apply` + a one-time
SSM install. The database still has no backup.**

**Orchestration lesson (mine, not an agent's).** Two agents were run concurrently against the
**same local `regulait_test` Postgres** and one saw broad, unrelated failures from the contention.
`CLAUDE.md` already names per-agent test databases as a convention; the briefs did not enforce it.
Enforce it in the brief, not in the retrospective.

### Enterprise-readiness planning wave (2026-08-01) — 26 Proposed ADRs

Owner asked for a meticulous pending-list and the functionality that makes RegulAIt sellable to
large enterprises, then triaged the resulting gap analysis. The outcome is a tracked plan
([docs/product/ENTERPRISE_READINESS_PLAN.md](../docs/product/ENTERPRISE_READINESS_PLAN.md)) and
**26 Proposed ADRs (0036–0061)** — decisions to pursue, each a starting design proposal that gates
on implementation, none built.

- **NOW (0036–0054):** identity (SAML/SCIM/group-mapping/session-mgmt/ABAC), the BYOC-first
  deployment decision, the two chosen security items (guardrail engine, MCP/OIDC egress), product
  depth (evals, MRM, review workbench, reporting, versioning, cost anomaly, lineage), and
  commercial plumbing (metering/billing, licensing, public API+SDKs, onboarding).
- **CORE, before go-live (0055–0061):** Shadow-AI Discovery, Governance Copilot, continuous
  red-teaming, compliance packs (EU AI Act / NIST AI RMF / ISO 42001), policy-simulation
  blast-radius, tamper-evident audit, ChatOps approvals.
- **DEFERRED (lists, not ADRs):** reliability/ops → `docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md`;
  later security (data-key off the DB volume is the top one) + compliance certification +
  marketplace/docs-portal → the plan's Bucket 3.

**The load-bearing decision is ADR-0041 (BYOC-first):** committing to single-tenant-per-deployment
makes the singleton org the *correct* control-plane architecture rather than a multi-tenant SaaS
rebuild — it turns the single biggest structural "gap" into a non-issue by decision.

**Three hard truths sit above all of it** and are not solved by any ADR here: no real LLM is
connected (key parked); the deployment is a single box (the deployment checklist, parked by owner);
and there is no compliance attestation yet (deferred — though the customer-facing compliance
*packs*, ADR-0058, are core, since selling EU AI Act compliance does not require us to be certified
first).

## Epics
| ID | Name | Status | Related |
|---|---|---|---|
| EPIC-01 | Bootstrap: AWS foundation + GitHub repo + session-continuity scaffold | **done** | ADR-0001–0004 |
| EPIC-02 | Governance layer MVP (§1–§10: MCP/agent/connector governance, infra-ops, compliance cascade, deploy model, Shared Projects, cost dashboard) | **MVP shipped** — all §1–§10 surfaces built and deployed; remaining work is depth, not first-build (see [ROADMAP.md](../docs/product/ROADMAP.md)) | GOVERNANCE_LAYER_SPEC.md, ADR-0007, ADR-0009, ADR-0014 |
| EPIC-03 | Workflow engine MVP | **MVP shipped** — declarative templates, stage machine, executable git/build/check/deploy/rollback stages, 6-dimension assignment matching | WORKFLOW_ENGINE_SPEC.md, ADR-0007, ADR-0018 |
| EPIC-04 | Token/cost optimization MVP (escalated to P0) | **MVP shipped** — all seven techniques live (routing, compaction, lazy tool-loading, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching) + a request-batching estimator; savings measured, not just estimated | TOKEN_OPTIMIZATION_SPEC.md, ADR-0007 |
| EPIC-05 | Multi-agent orchestration MVP (PM/Team-Lead/Worker delegation) | **MVP shipped** — task-graph DAG, governed worker dispatch + auto-advance, tool-using multi-turn workers, transitive entitlement AND budget ceilings | MULTI_AGENT_ORCHESTRATION_SPEC.md, ADR-0008, ADR-0016 |
| EPIC-06 | PM-tool integration MVP (Azure DevOps/Jira/etc.) | **MVP shipped** — the full adapter matrix (ADO, Jira, Linear, Asana, monday, generic webhook) + approval mirroring, decision records, inbound sync; deferral list is empty | PM_TOOL_INTEGRATION_SPEC.md, ADR-0008, ADR-0010 |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | **applied**, zero drift | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | **applied** (Admin-BreakGlass imported from its manual bootstrap creation, other two created by Terraform) | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | **live and private**: https://github.com/dhruvmahendrapatel/RegulAIt | EPIC-01 |
| COMPONENT-05 | Admin portal | **MVP shipped** — single-file API-client portal at /admin (ADR-0012), §6's eight panels + §10.4 cost surface | EPIC-02, ADR-0012 |
| COMPONENT-06 | Policy/allow-list engine (`packages/policy-kernel`) | **shipped** — default-deny kernel over MCP tools, agents, connectors; role grants (UNION-MAX, ADR-0014), per-user revocations, scoped rules, lead ceilings; pure, no I/O | EPIC-02, ADR-0009, ADR-0014 |
| COMPONENT-07 | Dev demo stack on AWS (`regulait-dev-app`) | **live** — EC2 `i-013c62adc887c76bb`, http://3.237.199.248:3000, dev-grade only; teardown = `terraform destroy` | ADR-0013 |
| COMPONENT-10 | Workflow orchestrator (`packages/workflow-kernel` + gateway) | **shipped** — declarative templates, stage state machine, executable git/build/check/deploy/rollback stages, assignment matching | EPIC-03 |
| COMPONENT-11 | Orchestration engine (`packages/orchestration-kernel` + gateway) | **shipped** — task-graph DAG, PM/Team-Lead/Worker delegation, transitive entitlement + budget ceilings | EPIC-05, ADR-0016 |
| COMPONENT-12 | Optimizer (`packages/optimizer-kernel`) | **shipped** — all seven pillar-6 techniques (routing, compaction, lazy tools, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching + batching estimator) | EPIC-04 |
| COMPONENT-13 | Provider packages (model / pm / git / connector / infra) | **partial** — model + PM matrices complete; git is GitHub-only, infra-ops mock-only, several connector kinds 501. See [ROADMAP.md](../docs/product/ROADMAP.md) | — |
| COMPONENT-14 | End-user app (`/app`) | **shipped** — playground, runs, workflows, inbox, projects, spend | EPIC-02 |
| COMPONENT-08 | caveman (output token compression, Claude Code plugin) | **installed**, user scope, no restrictions (verified fully local) | ADR-0005 |
| COMPONENT-09 | graphify (code knowledge graph, Claude Code skill) | **installed**, project scope, restricted to `--code-only` (verified) | ADR-0005 |

## Decisions
See [docs/decisions/README.md](../docs/decisions/README.md) for the full ADR index — that index is
the authority on how many exist and their status; do not restate a count here (this line claimed
"all nine ADRs" long after there were eighteen). All ADRs to date are Accepted; superseding a
decision means a new ADR plus a status flip on the old one, never an edit in place.
ADR-0009 (2026-07-24) chose the product stack: TypeScript
end-to-end — Fastify gateway + official MCP SDK, hand-rolled pure policy kernel (typed
`Decision` object, no OPA/Cedar), Postgres + Drizzle, pnpm-workspace monorepo
(`apps/gateway`, `packages/policy-kernel`, `packages/db`, `packages/shared`).

## Open Questions
None open. OQ-004 fully resolved: (a) caveman + graphify installed and documented (ADR-0005);
(b) standing policy for future scaffolds recorded (ADR-0006, no implementation yet — nothing to
apply it to until EPIC-02/03 produce a first template); (c) full product-feature spec written —
[docs/product/TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md), explicitly
scoped as a standard feature area (not a third P0 pillar), reusing the governance layer's
per-user entitlement system for model routing and the workflow engine's tag mechanism for a new
cost-sensitivity tag — cross-referenced from VISION.md §5.

OQ-001 (region allowlist) defaulted to `["us-east-1", "us-east-2"]` and is applied as the
region-allowlist SCP; OQ-002 (budget cap) resolved to $5/month; OQ-003 (GitHub account) resolved
to personal `dhruvmahendrapatel`.

## Known follow-ups (not urgent, not blocking)
- ~~`planning` is a vocabulary item, not a control~~ **CLOSED 2026-08-15 by
  [ADR-0079](../docs/decisions/0079-plan-only-stage-enforcement.md).** The kernel now RESTS at a
  planning stage (`blocked_on_plan`, left by an explicit `/advance`), an invoke may name an
  `instanceId` (validated on the initiator-or-admin bar), and a mutating mode against an instance
  parked there is refused `409 plan_only_stage` before dispatch, cache or billing. The
  mutating-mode rule is an ALLOW-LIST (`plan/review/chat/ask/read`) so a mode invented later fails
  closed. Honest limits kept in the ADR: attribution is OPT-IN (an invoke naming no instance is as
  unconstrained as before — mandatory attribution would need its own floor decision, like
  ADR-0021's), the rule binds declared intent rather than prompt semantics, and the MCP/compat
  paths carry no instanceId.
- **A deploy-override still has no second party.** ADR-0022's 2026-08-13 amendment made the
  initiator's self-attestation loud (recorded reason + `workflow:deploy-override-attested`), but
  routing the override to a genuine approver is the stronger control and needs a routing policy
  to say *who*.
- **Slice-9/10 findings (2026-08-15), reported not fixed:** (a) `sessionLifetimeHours`
  narrowing is issuance-scoped — an already-issued session keeps its stamped expiry, so a 2h-old
  session survives a 1h narrowing (ADR-0039's revocation levers are the pinned mitigation);
  (b) a failed PM approval-mirror is surfaced in the decide response (`pmMirror.ok=false`) but
  not persisted as a retryable marker — reconciliation currently rides drift detection.
- **Two pillar-6 savings-semantics questions (slice-5 probe, 2026-08-15), deliberately not decided in code:**
  (a) a semantic-cache HIT on a budget-blocked project is served (the cache sits before the
  budget gate) — $0 spend, but the `semantic_caching` savings row claims an avoided dispatch
  that would itself have been refused; (b) decision-only invokes write a `model_routing`
  estimate row with savings although nothing dispatches (pinned behaviour). Both are honest
  as estimates, misleading if the dashboard is ever read as "realized savings" — an owner
  call on reporting semantics, not a code defect.
- ~~Deployment-wide PII floor for unattributed dispatches~~ **RESOLVED 2026-08-13** — owner said
  build it. ADR-0021 amendment: `defaultPiiMode` now governs wherever no compliance framework
  does, including unattributed model/connector/MCP/cache/streaming/training-ingest calls.
  Default stays `none` (behaviour-preserving); one `PUT /v1/org/settings` turns the floor on.
- Security Hub's default standards enabled **both** AWS Foundational Security Best Practices and
  CIS AWS Foundations Benchmark v1.2.0 (the latter wasn't explicitly requested — AWS enables it
  by default alongside FSBP). Harmless; disable the CIS subscription later if its findings become
  noise.
- `infra/modules/aws-security-baseline`'s Config aggregator authorization assumes `us-east-1`
  only (single-region aggregation) — revisit if resources start landing in `us-east-2`.
- The forecasted (not actual) monthly spend shown in `aws budgets describe-budgets` was ~$1.21 at
  last check — almost entirely the two KMS CMKs (state bucket + CloudTrail). Nothing alarming
  against the $5 cap, but worth a glance next session.

**Enterprise-readiness build wave — identity + policy, 2026-08-02 (session-06).** The owner said
"start building the ADRs", turning the 0036–0061 planning set from a document into a work queue.
Six shipped in order, each its own migration, its own agent, and its own full-suite gate; the
gateway suite went **1,004 → 1,191** with zero regressions and the policy kernel **93 → 129**.

| ADR | Commit | Migration | What it makes true |
|---|---|---|---|
| 0043 | `59fef61` | 0049 | `mcp_servers.url` + `oidc_providers.issuerUrl` inside the egress guard — **every** admin-typed outbound URL is now behind one guard, one table, one pinned transport |
| 0039 | `0358b64` | 0050 | Per-session revocation, self-service device list, `last_seen_ip`, org CIDR envelope (`off`/`at_login`/`continuous`) with a separate API-key knob |
| 0036 | `a5e3216` | 0051 | SAML 2.0 SSO beside OIDC, `@node-saml/node-saml`, pinned-cert verification, replay seen-set, IdP-initiated opt-in |
| 0037 | `ab4d308` | 0052 | SCIM 2.0 `/scim/v2` — provisioning and, critically, **instant IdP-driven deprovisioning** as `disabledAt`, never a delete |
| 0038 | `4469d20` | 0053 | IdP group → role mapping: default-deny, additive, reconciled not accumulated |
| 0040 | `3351839` | 0054 | In-process Cedar ABAC on the kernel **allow path only** — can forbid or require approval, can never grant |

Five judgment calls worth remembering, because each one chose the safe side over the conventional
one:
1. **SCIM re-POST of an existing email returns 409, not the RFC-conventional 200-with-existing.**
   A 200 would let an IdP-driven create silently *adopt* a pre-existing local account — including
   an admin's. Refusal is audited as a deny.
2. **A role held both directly and via a group is two rows**, keyed by a composite unique including
   `origin`. The reconciler's `DELETE` is scoped `origin='group'`, so losing an admin's direct
   grant is *structurally* impossible rather than merely avoided by correct code.
3. **Missing groups claim ≠ empty groups claim.** An assertion that omits the claim means "no
   signal, do not reconcile"; an explicitly empty array means "member of nothing, reconcile to
   zero". Conflating them turns an IdP hiccup into an org-wide access strip.
4. **node-saml checks neither the assertion `Recipient` nor the login-Response issuer** (it pins
   `idpIssuer` only for logout). Both are checked in our code, against the assertion the library
   already signature-verified, so no new signature-wrapping surface is created. Its
   `acceptedClockSkewMs: -1` escape hatch — which disables timestamp checks entirely — is
   unreachable from config; skew is clamped to 0–9 minutes.
5. **The SAML correlation cache is the database**, not node-saml's in-memory default, which would
   fail *open* across a restart or a second process.

**A latent suite order-dependency was found and fixed at the source (`19d65b3`).** `saml.test.ts`
created ~30 enabled providers and deleted none; when vitest's duration-ordering cache happened to
run it before `auth.test.ts`, the ADR-0036-generalized `sso_only` guard returned 200, the assertion
failed *before* the test could turn `ssoOnly` back off, and every subsequent password login 403'd —
~20 unrelated failures cascading from one leak. Both files now snapshot/restore the org singleton
and delete the providers they create; auth's `sso_only` block establishes its own precondition
instead of inheriting a fresh DB. Proven by reproducing the exact cross-file order (22 failures
before, green after). **The general lesson: any test touching the `ORG_SETTINGS_ID` singleton must
restore it, because adding any new test file reshuffles the order and can surface this.**

**The wave completed and deployed, 2026-08-02→03 (session-06, PR #105 `27205e7`).** All 26 ADRs
(0036–0061) built across migrations 0049–0073; suite **1,004 → 1,611** across 100 files with no
regression. Merged to `main` and **deployed to the dev box** — 73 migrations applied, live at
`https://3-229-246-126.sslip.io/ui` on a valid Let's Encrypt certificate, login verified
end-to-end over the public URL.

Three things from the back half worth carrying forward:

1. **ADR-0060's own §1 was wrong, and the implementation says so.** Specifying `prev_hash` as the
   predecessor's `content_hash` builds *adjacent pairs*, not a chain — a deep edit plus a full
   recompute lands on an identical head and the anchor catches nothing, contradicting the ADR's
   own worked example. Built as the predecessor's `row_hash`, with the correction in the
   amendment. **An ADR is a decision, not scripture; implementing one is also reviewing it.**
2. **Parallel agents were a net loss and the record should say so.** Running two agents on one
   repo bought perhaps an hour across the final four ADRs and cost a wasted suite run, a merge
   repair, and — worst — a **defective commit reaching the remote**: `d61c5c8` was built from an
   index predating `16174e8`, so it silently deleted 1,127 lines of ADR-0058 while appearing only
   to add ADR-0059. Both agents detected the damage themselves and reported it accurately; the
   push was the main session's error. Repaired by re-applying the corrected content onto the clean
   sibling, resolving `schema.ts` as a union, hand-inserting journal entry 71 in `when`-ascending
   order, and force-with-lease over the bad tip after proving the new HEAD was a strict superset.
   **The file-partition strategy holds for isolated modules but not for the half-dozen files every
   slice must touch, and git's index is not partitionable that way. Prefer sequential.**
3. **A near-miss on false reporting.** An isolation run appeared to show the merge breaking
   `workflow-stage-quorum.test.ts` — until it turned out the merged tree had been re-tested against
   the database that had just run the full suite, while the baseline got a fresh one. On a
   genuinely fresh database it passed 5/5. **When a comparison implicates your own change, check
   that both sides were actually given the same conditions before reporting a regression.**

Two suite-hygiene fixes landed as a side effect: the vitest default 5s timeout was too tight for
~1,600 sequential real-Postgres e2e tests (raised to 20s — deliberately not "no timeout", so a hung
request still fails), and `saml.test.ts` was leaking ~30 enabled SSO providers that cascaded into
~20 unrelated failures depending on vitest's duration-ordering cache.

**What is NOT built** is tracked in
[docs/product/PENDING.md](../docs/product/PENDING.md) — read that before planning the next session.

## Standing guardrail
Nothing gets a "production" designation, and nothing deploys to one, without the user's direct,
explicit sign-off in that session. See [CLAUDE.md](../CLAUDE.md).
