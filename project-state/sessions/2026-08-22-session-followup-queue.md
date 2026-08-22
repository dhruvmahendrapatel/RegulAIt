# Session — 2026-08-22: the follow-up queue, the credential, and the copilot

Immutable session record (append-only convention; never edited retroactively).

## The owner's three directives, in order

1. **"Document everything pending for when we have appropriate information."**
   → `docs/product/PENDING.md` gained a complete post-queue addendum: every open
   item with its exact unblock condition, grouped by what arrives (credential /
   owner decision / live instrument / deliberate refusal / anytime follow-up).
   Written the same day the harness task list was lost to a workspace rollback —
   which proved the point that in-repo docs are the only durable ledger.
2. **"Clean UI, new-user experience, enterprise grade"** (with the ui-ux-pro-max
   skill) → **ADR-0093**: 26-entry nav split into 11 question-shaped sections,
   one `SeverityBadge` vocabulary (two disagreeing local maps deleted), a
   dismissible first-run orientation. Then, on the owner's follow-up
   (*"each product on its own page, navigated from dashboard tiles"*) →
   **ADR-0094**: Home became a tile launcher, the sidebar scopes to one suite at
   a time, with the cross-suite `/` filter and a switcher as the two
   anti-stranding affordances. Routes byte-identical throughout.
3. **"Finish everything you can without me."** → batches B1–B5 and L6 below.

## The batches

- **B1** (ADR-0073/0058, migrations 0095/0096): rule CRUD built honest-first over
  versioning; `agent_config` became real versioned dispatch config with a
  zero-influence shadow canary; pack activation seeds its §8.3 profile.
- **B1.5** (ADR-0095): the owner's own finding — a mock agent answering a
  cost-sensitive chat while a live credential existed. Mocks now route only when
  no credentialed live agent can serve; savings never priced mock-vs-live; seed
  model id refreshed; `PATCH /v1/agents/:id` rides the versioned edit path.
- **B2** (ADR-0090/0091, migration 0097): expiry sweep that decides nothing;
  review reassignment; SoD N-way + pattern selectors.
- **B3** (ADR-0080/0086/0089, migration 0098): three default-off enforcement
  opt-ins, each proven byte-identical until flipped.
- **B4** (ADR-0063, migration 0099): the resumable key re-encryption walk.
- **B5** (ADR-0049/0052): scratch-DB collisions cured; cost floor sourced; two
  tier flags enforced.
- **L6 + L24-half** (ADR-0056/0092 amendments, migration 0100): the copilot goes
  live through governed dispatch, grounded in retrieved object ids with an
  empty-retrieval refusal; proposals get a consent-gated applier on the real
  choke points; recommendations get an opt-in model-judged annotation layer.

## The credential

The owner supplied a Google/Gemini key mid-session. Live verification **V1–V7 all
passed** for ~$0.007 (`docs/product/LIVE_VERIFICATION_2026-08.md`): governed live
dispatch with real metering, streaming, PII-cascade-precedes-dispatch against a
live backend, judges both ways (model-judged AND the keyless 422), live-graded
red-team trials, live-aware routing. One environmental finding: `gemini-2.5-pro`
is retired for new Google accounts. L6's own live run added copilot narration,
the grounded refusal (the model itself refused a nonsense object), an applied
proposal, and 40/40 judged annotations.

## Process ledger

- **M-021** (REPEAT of M-006): `pkill -f` matched the invoking shell again.
  Rule rewritten: reflex-sized commands are exactly where logged rules get
  skipped — bracket the pattern or use `pkill -x`, no exceptions.
- **M-022**: the first L6 attempt died to a model limit, and the workspace
  rollback that followed erased its unpushed commits. "Commit small, don't push"
  trades durability for tidiness; in a rolling-back container that is the wrong
  trade. Agents now push every scoped commit immediately.

## State at close

Gateway **153 files / 2437 passed + 9 MinIO skips**, shared **742**, Playwright
**136/136**, migrations 0001–0100 from zero. Everything pushed to
`claude/status-check-2gbrwf` (PR #108). The autonomous queue is empty; what
remains is owner-gated: L13 (AI pre-fill vs "the answers are yours"), L19
(certification spend), the PII floor default, other providers' keys, live PM
credentials, and P2 (HA, when there is a customer to serve).

## Addendum — hands-on testing of the live copilot (same day, later)

The owner asked for a local pull-and-test of the copilot plus a refresh of every
tracking file. A fresh database was seeded from HEAD and the copilot driven
against the live Gemini credential on a local gateway.

**Confirmed working:** deterministic grounding cites real `audit_log` ids; live
narration returns `generation: model` / `modelNarrationVerified: true` through
the governed dispatch path; the calls are metered (2 usage rows, 1,804 in / 603
out, ~$0.008, attributed) and audited as `copilot-question-answered`; the
decision-support notice and scope caveat appear on every answer.

**Defect found — the reason hands-on testing exists.** Asked to *"Summarise the
Zorblatt Quantum Compliance Widget approvals from last week"* — an entity that
does not exist — the copilot did not refuse. The keyword planner matched only
"approval"/"last week", ran an unfiltered `listApprovals`, retrieved 8 real
org-wide approvals, and the model narrated *"for the Zorblatt Quantum Compliance
Widget, 8 approvals were requested, 4 approved, 4 pending"*. Every existing
guard passed honestly: no figure was invented, no id was invented, retrieval was
not empty. The missing check is whether the question's SUBJECT was ever used as
a filter. `modelNarrationVerified: true` made it worse by stamping the sentence
as checked.

Fix dispatched the same turn: filters disclosed to the narrator with a hard rule
against attributing findings to entities that were never filtered on, plus a
deterministic caveat that survives a misbehaving model, plus an ADR-0056
amendment stating exactly what the verified flag means.

**Process lessons logged.** M-023: I described a two-file run as "the hostile
order" reproduction before running the negative control — which then also
passed, so the pairing had proven nothing. M-024: L6's own live verification
exercised the grounded refusal only where retrieval returned zero rows, the case
where refusal is nearly automatic; the case where plausible real data exists but
does not answer the question was never tried, and that is precisely where the
hole was.

Also this stretch: an order-fragile SoD audit assertion (taking the oldest
`sod-override-minted` row in a shared database) was caught by an independent
full-suite run and scoped to its own approval; `docs/product/TESTING_CHECKLIST.md`
gained rows 31–41 for everything shipped in this wave.

## Retest of the copilot fix (ADR-0056 L6d) — 2026-08-22, live

Pulled `ae17aec`, rebuilt, restarted the local gateway against the same seeded
database and the live Gemini narrator. Four cases, chosen so that a fix which
merely made the copilot evasive would fail two of them:

| Case | Result |
|---|---|
| **A. The defect** — "Summarise the Zorblatt Quantum Compliance Widget approvals from last week" | **FIXED.** Narration now reads *"…with no filters applied (across all records in scope, **not only Zorblatt Quantum Compliance Widget**), 8 approvals were requested…"*; `subjectFiltered: false` plus the deterministic UNFILTERED SUBJECT caveat. The fabricated attribution is gone. |
| **B. Must still answer** — "What governance denials happened recently and why?" | Normal, useful answer; `subjectFiltered: true`, filter `effect=deny` disclosed, no caveat. The guard has not over-fired. |
| **C/D. Must still refuse** — empty retrieval (an entitlement-empty user) | `rows=0`, `cited=0`, `groundedRefusal: true`. The original L6a guard is intact alongside the new one. |
| **Bonus governance check** | An entitlement-empty user naming the seeded Google agent as narrator gets `403 narrator_not_entitled` — you cannot narrate with an agent you may not invoke (ADR-0056 tenancy rule, holding live). |

A nicety worth noting: when a filter IS applied but is not the question's
subject (e.g. "approvals in state rejected" planned as `effect=deny`), the model
still says *"with the filter 'effect=deny' (across all records in scope, not
only approvals in state rejected)"* — accurate on both counts.

**Two probe errors of my own during the retest, both mine and not the app's**
(M-004 discipline): my "empty retrieval" control initially returned 103 rows
because I assumed a question would produce a state I never verified, and my
user-creation probe used the wrong field name and read the wrong key field.
Fixed each and re-ran rather than reporting around them.

## Retest of entity-aware planning (ADR-0096) — 2026-08-22, live

Pulled, rebuilt, fresh seeded database, live Gemini narrator. Five cases, criteria
written before the run:

| Case | Result |
|---|---|
| **A. The original defect** — "Summarise the Zorblatt Quantum Compliance Widget approvals from last week" | **422 `copilot_entity_unresolved`.** No answer, no model call. The message names the six resolvable kinds and states outright that it will not fall back to a broad query and label the findings with the caller's words. |
| **B. Real entity narrows** — `spent this month on "demo-project"` | **15 rows filtered vs 20 unfiltered.** The filter genuinely narrows; the plan carries `{kind: project, id, name, matchedOn}` and the narration names the filter. |
| **C. Control, no entity** | Unchanged useful answer. |
| **D. Empty retrieval** (user with no projects) | `groundedRefusal: true`, rows 0 — a **201 with a grounded refusal**, structurally distinct from A's **422**. The two "I can't answer" cases are now separable by a caller. |
| **E. Scope honesty** | A real-but-invisible project and a genuinely nonexistent name produce refusals that are **byte-identical after substituting only the caller's own word**, with no id leak. Invisible is indistinguishable from nonexistent. |

Independent full gateway suite on a fresh database: **154 files / 2450 passed + 9
skipped**, matching the build agent's numbers.

The arc this closes: the copilot originally attached 8 real approvals to a
fabricated subject and stamped it verified (found by hand, 2026-08-22). L6d made
it disclose that it had not filtered. ADR-0096 makes it refuse instead — and the
non-vacuity probe that mattered was "report the filter but make it a no-op in
SQL", which reddened three tests with `expected 8 to be 3`.

## Retest of B6 (ADR-0095/0080/0096 dated amendments) — 2026-08-22, live

Pass criteria written before results, per the standing retest discipline. Gateway
built from origin head `4163983` on a fresh `regulait_b6live` DB, live Google
credential in process env only (never in any file).

| Case | Criterion (pre-written) | Result |
|---|---|---|
| A — mock-shadowing unified (B6a) | With the live credential seeded, decompose picks a live-served lead; skipped mocks disclosed as `mock_shadowed_by_live` on the `run-decomposed` audit row; a google usage row exists | **PASS** — lead served by the live model, disclosure present, usage metered |
| B — attribution knob (B6b) | 2×2: knob on/off × projectId present/absent. 409 `attribution_required` ONLY in on+projectless, and **before any provider call**; other three cells reach the provider | **PASS on the gate.** The on+projectless cell 409'd pre-provider; the other three cells reached the provider, which returned 502 `model_dispatch_failed` — extracted detail: Google quota exhausted ("You exceeded your current quota"). Provider-side, not app-side; the asymmetry (409 pre-provider vs 502 AT the provider) itself proves the gate ordering |
| C — MCP entities (B6c) | `"repo-tools/search_code"` narrows retrieval with a real row delta; bare server name narrows to the server's tools; dana (revoked on search_code) gets a refusal byte-identical to a nonexistent tool; C2 unresolved-refusal enumerates the new kinds | **PASS** — after generating real MCP deny rows (dana proxy calls → 403), unfiltered 108 → tool-filtered 1 → server-filtered 4; scope honesty byte-identical after word substitution; refusal names mcp servers/tools |

**Quota note:** the owner's Google key hit its quota ceiling mid-retest. Every
gate/refusal/disclosure above is proven; further *narration-content* live work is
parked until the owner refreshes quota (PENDING.md credential section updated).

### Independent full-suite verification — one failure, diagnosed as a latent flake

My fresh-DB rerun of the whole gateway suite returned **156/157 files,
`agent-config-versioning.test.ts` failed in `beforeAll`** (11 tests skipped) — the
B6 agent's two runs had been green. Diagnosis with the failed run's REAL data
(the canary users persist in the DB): the setup drew 12 random users and wanted
an inside subject (first bucket ≤ 97) plus a later draw with a strictly greater
bucket; the actual draw order was `94,48,83,72,19,52,45,4,8,18,27,35` — nothing
beat 94. Negative control per M-023: the same loop over fresh random UUIDs fails
**7.13% of 100k simulated batches** (and passes ~93% — exactly matching
agent-green-twice, me-red-once). Not B6's code — a latent flake in the earlier
config-versioning suite. Fix `445a77d`: select the inside/outside pair as the
**min/max buckets over the whole batch** — same pure sampling function, but
failure now requires all 12 hash draws ≥ 98 or all equal, i.e. a broken hash,
not bad luck. Targeted rerun 11/11. **Full-suite rerun on a fresh
`regulait_test`: 157 files / 2475 passed + 9 MinIO skips — green**, matching the
B6 agent's own runs. B6 is closed: built, independently verified, live-retested,
and the one discrepancy between my run and the agent's runs is explained and
fixed at its root (`445a77d`).
