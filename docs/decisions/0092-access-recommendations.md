# ADR-0092: Access recommendations — the deterministic half, shipped as queries with reasons (gap L24)

- **Status**: Accepted
- **Date**: 2026-08-21
- **Driver**: [GAP_ANALYSIS_SAVIYNT_2026-08.md](../product/GAP_ANALYSIS_SAVIYNT_2026-08.md) §L24
- **Migration**: 0094 — one CHECK widening only (`from_recommendations` joins the ADR-0090
  campaign-scope vocabulary). Recommendations themselves have **no table, no stored rows, no
  rollup**: everything is computed at read time in the ADR-0082 discipline.
- **Extends**: [ADR-0082](0082-inventory-and-posture.md) (the read-time-aggregation discipline and
  the unobserved-is-said disclosure), [ADR-0089](0089-agent-ownership-alignment.md) (ownership,
  lifecycle and the overreach flag this re-surfaces), [ADR-0090](0090-grant-certification-campaigns.md)
  (the campaign loop that is the ONLY action path), [ADR-0091](0091-sod-toxic-combinations.md)
  (the violator sweep this re-surfaces), [ADR-0085](0085-eu-ai-act-tier-screening.md)/[ADR-0083](0083-shadow-ai-first-party-discovery.md)
  (the frozen-versioned-rule-set pattern the shared half copies).

## Context

Saviynt's Intelligence Suite recommends who should lose or gain access — peer-analytics, dynamic
roles, weighted trust scoring — and embeds a copilot across its flows. The gap analysis split L24
honestly: the copilot and everything model-judged stay **credential-blocked** (the L6 wall;
POSITIONING §6 forbids claiming it meanwhile), and the half that is ours to ship NOW is
**deterministic recommendations over ledgers we already hold**. The raw signal existed —
granted-vs-observed (ADR-0082), ownership/lifecycle/alignment (ADR-0089), campaign machinery
(ADR-0090), SoD violators (ADR-0091) — but nothing turned it into a worklist that says *this
grant, this reason, this evidence, this action*.

## Decision

**Every recommendation is a stated rule over the ledgers, its evidence attached, its action
routed through machinery that already exists. No scores, no ranking magic, no "intelligence"
label — and the model-judged half is NOT approximated: a heuristic sold as intelligence would be
exactly the overclaim this project refuses.**

### 1. The frozen shared rule set — `ACCESS_RECOMMENDATION_RULES_V1`

`packages/shared/src/access-recommendations.ts`: a fixed, versioned, deep-frozen, **data-only**
list (the ADR-0085/0083 discipline — a better rule is a v2 alongside, never an in-place edit
under results that cited v1). Each rule carries an id, a plain-language rationale **template**
(rendered strictly per finding — a missing evidence value throws rather than shipping a sentence
with a hole), a stated `limits` paragraph that travels on every payload, and a **severity class**
(`informational | review-suggested`) — a class, never an ordering claim; the shared suite pins
that no field on the shape is numeric. The launch set, each verified computable before admission:

| id | severity | reads |
|---|---|---|
| `unused-grant` | review-suggested | grant `created_at` vs the pillar-5 usage ledger (see §2) |
| `orphaned-agent-grants` | review-suggested | ADR-0089 ownership flag (`unowned`/`orphaned` both flagged, evidence says which) |
| `retired-agent-grants` | informational | ADR-0089 lifecycle — dispatch already refuses; the row is dead weight, so no exposure is implied |
| `overreach` | review-suggested | the ADR-0089 alignment flag re-surfaced with its evidence, never re-judged |
| `sod-violation` | review-suggested | ADR-0091's read-time violators with each rule's recorded reason AND the concrete conferring grant rows |
| `never-signed-in-holder` | review-suggested | see §3 — computed from what the tables actually record |

**No rule was dropped as uncomputable**, but two were reshaped by verification against the real
tables rather than implemented from the brief's assumptions (§2, §3).

### 2. `unused-grant` — the observed source is METERING, and the honest correction this forced

The brief for this slice assumed the ADR-0082 observed block (the ADR-0070 trace ledger) would be
the usage source, and therefore that "tracing off" must surface as `not_assessable`. **Verified
against the insert sites, that premise is false**: every EXECUTED governed call — model dispatch
(`agents-connectors.ts`), connector invoke, MCP tool call (`mcp-proxy.ts`, unconditional for
allowed executed calls) — writes a `usage_events` row **with the calling user's id**, regardless
of the tracing switch, and the usage ledger is never pruned (the retention pass covers
`audit_log` + traces only). Tracing gates the *agent-attribution* of tool calls, not holder-level
use. So the rule reads `usage_events` (per-holder pairs for agents — served AND requested ids, so
a routed dispatch still exercises the requested grant — connectors, MCP tools via the
`detail->>'serverId'` jsonb, and server-wide grants as any tool call on the server), and
switching tracing off does **not** blind it — recorded here so the correction is a decision, not
drift.

The ADR-0082 disclosure discipline still binds, where it is genuinely true:

- **`not_assessable`, never unused**: a role-bundled grant whose role has **no current assignee**
  has no holder to attribute use to — it surfaces in a separate `notAssessable` block with its
  reason, never among the findings, and the posture line states the count outright.
- **The window is a parameter, not a truth**: `windowDays` (default 90) rides in per request, is
  echoed into every finding's evidence, and a grant younger than the window is simply **not
  judged** (neither flagged nor not-assessable). The suite pins that widening the window makes a
  finding disappear.
- **Executed calls only**: denied attempts are not use; out-of-gateway activity is invisible —
  though it also never exercised a gateway grant. Stated on the payload (`notes.observed`).
- Evidence per finding: grant age, window, `governedCallsInWindow: 0`, and the **last governed
  use ever** (or `never`) — enough to re-derive by hand.

### 3. `never-signed-in-holder` — computed from what is recorded, and only that

The users table records **no last-login timestamp** (verified before claiming). The rule
therefore reads the signals that DO exist: `users.disabled_at` (facet `deactivated` — the grants
are already inert at the auth wall, flagged because inert standing access is still standing
access), and facet `never_authenticated` = no `auth_sessions` row ever minted (session rows are
revoked, never deleted — verified: no delete site exists) AND no API key with `last_used_at` AND
no usage row naming the user. Direct grants only — a role is not a person. The evidence names
which signal fired.

### 4. One read-only endpoint — nothing executes, ever

`GET /v1/recommendations/access` (admin via the default gate, tagged internal/`recommendations`
in the ADR-0053 registry): computes all rules at read time. Each finding carries rule id +
version, the rendered rationale, the concrete evidence, the affected identity/grant, and the
available ACTION — the `from_recommendations` campaign scope payload plus the existing revocation
endpoint reference (`DELETE /v1/grants/...` / `DELETE /v1/roles/:id/grants/...`), per kind, with
the concrete row id. `sod-violation` findings are identity-shaped and list the conferring grant
rows for both sides (mirroring ADR-0091's holding semantics, including revocation subtraction).
The suite pins that computing the report writes **no audit row, no approval, and touches no
grant** — recommendations never notify, never auto-open, never revoke.

### 5. The campaign feed — the ONLY action path, one more scope filter

ADR-0090's scope vocabulary gains `from_recommendations` (migration 0094 widens the DB CHECK;
scope value = comma-separated rule ids, parsed by ONE shared `parseRecommendationRuleIds` —
unknown ids and empty lists refused by name, 422 `invalid_recommendation_rules`). At preview and
at open, the snapshot is **exactly the grant rows those rules flag at that moment** — computed
then, not stored — implemented as a filter over the SAME enumeration `snapshotGrantsForScope`
already runs, not a parallel snapshot path. Everything downstream is untouched ADR-0090
machinery: reviewer routing on the ownership spine, the one approvals queue, the decider-keyed
own-grant bar, revoke-is-real, expiry-on-read. The suite drives the loop end to end: the campaign
items are asserted **set-equal** to the endpoint's own findings, a flagged grant is revoked
through the one decide path, and the next report no longer flags the removed row. An empty flagged
set hits ADR-0090's existing `no_grants_in_scope` refusal.

### 6. SPA + posture

Nav: **Access recommendations** between the Agent inventory and Certification campaigns (the
worklist between the ledger view and the review loop). The page renders each rule as a card —
severity as a **badge** (a class, not an ordering; findings are not sorted by any score), the
rendered rationale plus a hand-checkable evidence line per row, the `notAssessable` block stated
outright, each rule's limits paragraph verbatim, and one button: "Open certification campaign
from these" (name `recommendations: <rule>`, due +14 days). The manual campaign form deliberately
does not offer the scope — it is opened from the page where the flagged set is visible. Posture
gains an **Access recommendations** card/section: findings by rule with severities, "none" stated
as a computed fact, and the not-assessable count stated outright. Playwright
(`zz-zz-zz-access-recommendations.spec.ts` — sorts last, after the `zz-zz-` specs;
order-independent sign-in per M-017) seeds an unused grant (backdated in the ledger) and an
orphaned one, asserts both render with evidence, opens the campaign from the unused rule, and
asserts the campaign items match the flagged set against the gateway's own APIs.

## Non-vacuity (M-002 — every count below MEASURED by running the probe, then reverted by exact Edit reversal)

- **One rule constant-empty** (`retired-agent-grants` findings never added): **2 tests redden** —
  the retired finding/evidence test, and the campaign set-equality test (its `expected.size > 0`
  guard). The preview-count test alone stays green under this probe because its expectation and
  the preview ask the SAME oracle — which is exactly why the set-equality test carries the
  non-emptiness guard; recorded here rather than hidden.
- **Campaign feed resolves to nothing** (`computeRecommendedGrantRefs` returns `[]`): **2 tests
  redden** — the preview-count test and the open-campaign set-equality test.
- **`not_assessable` collapses into unused** (empty-role branch no-op'd, so the holderless grant
  falls through to the unused computation): **2 tests redden** — the role-with-no-assignee case
  (presence in `notAssessable` AND absence from findings) and the posture line (the stated
  not-assessable count drops to zero).

## Honest limits — stated, not buried

1. **The deterministic/model-judged split is the product.** Peer analytics, anomaly judgment,
   dynamic roles, trust scores and the embedded copilot are the L6-blocked half; nothing here
   imitates them, and severity is a class precisely so no number exists to be mistaken for a
   trust score.
2. **The window is a parameter, not truth.** 90 days of disuse under one window is zero findings
   under another; every finding echoes the window it was judged under.
3. **Observed sees only governed, executed traffic.** Metering is tracing-independent (§2), but
   denied attempts are not counted as use, and nothing outside the gateway is visible.
4. **Rules are v1 and versioned** like the other frozen sets — revision is a v2 alongside, never
   an edit under results that cited v1.
5. **No per-user notification, no scheduler, no auto-anything.** A recommendation nobody reads
   changes nothing; the posture line is the standing surface.
6. **Re-surfaced flags are not re-judged.** `overreach` and `sod-violation` quote ADR-0089/0091's
   own computations (imported, never reimplemented); their limits are inherited verbatim.
7. **`never_authenticated` is a floor over recorded state**, not an HR feed: a user who
   authenticated before this deployment recorded sessions reads as never-authenticated only if
   truly nothing (session, key use, usage) names them.

## Amendment — 2026-08-22: the MODEL-JUDGED half, as an annotation and nothing else (L6c, migration 0100)

This ADR's honest limit #1 said "the deterministic/model-judged split is the
product… the embedded copilot are the L6-blocked half; nothing here imitates
them". The L6 wall is down (ADR-0056 amendment, same date), so the judged half
is now buildable. This amendment is a **delta**: every deterministic rule,
every disclosure and every limit above stands unchanged, and that is the point
— the judged layer is added BESIDE them and can reach none of them.

### What was built

An **opt-in, default-off ANNOTATION** on findings the deterministic rules
already produced. Five properties, each structural rather than promised:

1. **Default off (the batch-B3 idiom).** `org_settings.recommendation_judge_enabled`
   ships `false` and `recommendation_judge_agent_id` ships null, so an
   untouched deployment's report is byte-identical to what this ADR shipped.
   The report ALWAYS carries a `judged` field, whose off-state says so outright
   rather than leaving the absence implied.
2. **It cannot create a recommendation.** Every finding now carries a stable
   deterministic `key` (rule + grant row, or rule + holder for the
   identity-shaped SoD findings), minted as the finding is created.
   `annotationsForFindings` is handed exactly that key set and DROPS any
   verdict keyed to anything else — so a judge that invents
   `peer-analytics:user:u9` produces nothing at all.
3. **It cannot alter deterministic evidence.** `annotateReportWithJudge`
   assigns exactly two things: `report.judged`, and `finding.judged` on
   findings already present. It never assigns `evidence`, `rationale`,
   `severity`, `counts` or `action`, and it never reorders. The suite asserts
   the whole deterministic half is **byte-identical** between a knob-off run
   and a knob-on annotated run.
4. **Every annotation is LABELLED.** `method: "model-judged"` is stamped, not
   defaulted, and each annotation carries `RECOMMENDATION_JUDGE_LIMITS`
   verbatim: advisory, not evidence, did not create the finding, cannot change
   severity, and **does not clear a grant** — only a named human's decision
   does. Severity remains a class; the judged layer adds no number, so nothing
   here can be mistaken for the trust score this ADR refused to ship.
5. **A missing instrument is SAID, never a silent downgrade.** Availability
   rides ADR-0067's own `judgeAvailabilityFor` — the same typed refusal the
   eval runner uses. Enabled with no judge named → `judged: unavailable`,
   `judge_required`. Enabled with an unreachable/uncredentialed judge, or a
   judge that throws or returns an unusable reply → `judged: unavailable`,
   `judge_not_dispatchable`, with the reason verbatim. In every case the
   deterministic report is returned **unchanged**: an unannotated report from a
   working judge and one from a missing judge are different facts.

The judge is `ModelBackedRecommendationJudge`, an ordinary governed dispatch
through `executeGovernedDispatch` — the caller's entitlements, the caller's
budget, the PII cascade, the guardrails, and a metered `usage_events` row
billing the named project. It is a tenant, exactly like the copilot's narrator.

**The campaign feed is deliberately untouched.** `computeRecommendedGrantRefs`
takes no judge and never will: the ONLY action path stays deterministic, so a
disagreeing model cannot shrink what a certification campaign reviews. The
suite pins this with a judge that disagrees with everything.

### Non-vacuity (M-002 — MEASURED, then reverted by exact Edit reversal)

- **Let the judged layer mutate a deterministic field** (`f.evidence = { ...f.evidence, judgeVerdict: a.verdict }`
  beside the annotation): **1 test reddens** — "ANNOTATES findings when enabled
  and a judge is reachable", on its byte-identical deterministic-shape
  assertion. The containment assertion is what catches it, which is the point:
  the shape comparison is the guard, not the annotation's own presence.
- The shared suite additionally pins the containment function directly: a
  verdict keyed to an invented finding is dropped, a repeated key cannot
  double-annotate, and an unparseable or empty reply is an ERROR rather than
  zero verdicts.

### Live verification (2026-08-22, Google/Gemini)

Knob off → `judged: {enabled:false}`, 40 findings, 0 annotations. Knob on with
no judge named → `judged: unavailable / judge_required`, deterministic half
identical. Knob on with the live agent → `judged: judged`, `judge:
model:gemini-pro`, **40 of 40 annotated**, every annotation
`method: "model-judged"`, the finding key set unchanged, and the deterministic
half **byte-identical** to the knob-off run. Metered: 5086 in / 3431 out,
$0.0407, attributed to the named project.

### Honest limits added by this amendment

1. **The judged layer is advisory and unverified as a judgement.** That a model
   said "agree" is a fact about the model, not about the grant. On the live run
   it agreed with all 40 findings — which is as consistent with a well-behaved
   judge as with an agreeable one, and this build cannot tell those apart.
   Nothing downstream reads the verdict.
2. **Batching is disclosed, not unlimited.** `RECOMMENDATION_JUDGE_MAX_FINDINGS`
   is 20 (measured down from 40: a 40-finding batch cost 3431 output tokens on
   top of 2615 thought tokens, and a second identical run truncated instead and
   correctly reported `judged: unavailable`). A report larger than one batch
   states how many findings were sent, so partial annotation is visible rather
   than silent.
3. **One live model, one run**, as in the ADR-0056 amendment.
4. **The judge sees rendered rationales and evidence maps, not the ledgers.**
   It cannot re-derive a finding; it can only assess the evidence it is shown.
   That is deliberate — a judge with ledger access would be a second, unaudited
   read path — but it bounds what its opinion can be worth.

### Migration

`0100_copilot_apply_and_judged_recommendations.sql` — `org_settings` gains
`recommendation_judge_enabled` (default false) and `recommendation_judge_agent_id`
(nullable). No data movement; reversing the knob restores the prior behaviour
with every row intact.
