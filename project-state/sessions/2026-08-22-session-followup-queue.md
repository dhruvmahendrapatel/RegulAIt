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

## Batch B7 + retest — 2026-08-22 (night)

The owner's "continue with the remaining pending items" after B6 close-out. The ledger's
owner-gated set is unchanged; the three genuinely buildable residual groups became B7,
agent-built sequentially (each on its own scratch DB, push-every-commit), then independently
verified and hands-on retested. A fifth silent workspace rollback preceded the batch
(restored from origin, M-022/M-025 protocol — zero loss).

- **B7a** (`91e7c9d`, ADR-0096 amendment): the seven remaining entity kinds resolve —
  initiative + virtual_key multi-ledger filterable with row-delta proofs; packs/use
  cases/risks/templates/roles audit-filterable; visibility per kind = its own list endpoint's
  scoping; no-op-filter probes redden 9 tests.
- **B7b** (`2608bb2`+`b794837`, ADR-0052 amendment): all four remaining tier flags enforce at
  their enabling acts; four expansion points wired expansion-class; 11 wired points reported;
  honest non-close: no §4 flag exists for connector/MCP/PM creation.
- **B7c** (`96193aa`..`77f2f38`, ADR-0073 amendment, migration 0102): canary-observation
  retention sweep (job + door + knob; versions NEVER pruned; live-canary evidence kept),
  subject-delete AFTER DELETE trigger (activation ledger, not the hash-chained audit_log),
  and the `usage_events` agent_config served-version stamp (FK-free, mirrors the prompt stamp).

**Independent verification**: fresh `regulait_test` at head `77f2f38` — **161 files, 2509
passed + 9 MinIO skips, green**; journal idx/when unique+ascending.

**Hands-on retest** (criteria pre-written in scratchpad b7-retest-criteria.md; keyless
gateway :3221 on seeded `regulait_b7live`): **ALL PASS.**
- A: initiative narrowed usage 19→15 (real rows both sides; the audit-side 94→0 is correct
  exclusion — invoke audit rows carry no projectId, only project-attributed ledgers match);
  role two-user proof — admin resolves, non-admin's refusal byte-identical to a nonexistent
  name after substitution, with the admin-nonexistent negative control also refusing; pack ×
  spend → 422 `copilot_tool_cannot_filter_entity` naming kind+tool+id; the unresolved body
  enumerates all new kinds.
- B: four 403s (`license-absent-feature-closed`, feature named, 4 audited deny rows); pack
  seeding 201 and basic `POST /v1/runs` 201 on the same ABSENT license; 11 wired points.
- C: stamp = v3 then moves to v4 on activation (seed-era rows all NULL = unversioned
  control); prune door → pruned=1 / keptLiveCanary=1 / all versions intact / audited fact;
  raw SQL delete of a versioned agent → pointer retired + trigger-authored
  `artifact_deleted` ledger entry; scheduler off with 10 registered jobs incl. the sweep.
- D: keyless demo unchanged (mock serves, copilot grounded answers + caveat).

**Process**: M-026 logged — I read decision-only invoke 200s as executions twice (the
false-FAIL on the stamp column cost four diagnostic steps before M-004 discipline caught
it); rule: verify state-generating probes by the state they claim to write, and
`/v1/agents/:id/invoke` executes nothing without `dispatch: true`. The B7c agent's flagged
"ADR index drift" did not reproduce (96 files = 96 rows). Google quota still exhausted —
all retest instruments keyless by design.

## Batch B8 + retest — 2026-08-23

The buildable tail after B7 became B8, agent-built sequentially, independently
verified, and hands-on retested keyless (criteria pre-written before any slice
reported; probe discipline per M-026 — every state-generating probe verified by
the row it wrote). One more silent workspace rollback (7th) absorbed with zero
loss before dispatch.

- **B8a** (`32ae134`+`ec94527`, ADR-0096 amendment): vendor × audit filter
  (`object_type='ai_vendor'`), ai_use_case × approvals (own instance pointer,
  fail-closed to ZERO_UUID), workflow_template × approvals (`template_ids @>`);
  old refusal tests replaced by row-delta tests, still-refusing pairs pinned.
- **B8b** (`eb2618b`+`cff10be`, ADR-0073 amendment, no migration): profile-shadow
  divergence persists write-through into `config_canary_observations`
  (candidate×project×fingerprint dedup; 50-cap disclosed in-row; B7c prune covers
  it unchanged) and feeds `complianceProfileCanaryDivergence` on the ADR-0059
  preview, read-only, byte-absent without recorded divergence.
- **B8c** (`07b1ed6`+`f9b24b1`, ADR-0056 amendment, no migration): the last two
  proposal kinds apply via PRE-EXISTING routes through extracted shared
  implementations; the applier runs each route's own zod; five refusal legs
  pinned; stale "unapplied" disclosures removed.

**Independent verification**: fresh `regulait_test` at `f9b24b1` — **163 files,
2535 passed + 9 MinIO skips, green**. ADR index 96=96 (the agents' repeated
"96-vs-95 drift" flags did not reproduce — they misread CONTRIBUTING §4.4's
example as a live finding).

**Hands-on retest** (gateway :3222, seeded `regulait_b8live`, keyless): **ALL PASS.**
- A: vendor audit 94→3 on product-written rows (create + 2 patches); use-case
  approvals 9→1; template approvals 9→1; vendor × spend 422 naming kind+tool.
- B: divergence read persists + dedups (re-read writes nothing); non-diverged v2
  and diverged v3 both recorded with history kept; simulation control (real 201,
  field absent) then positive (field lists hipaa candidate v3, 1 diverged
  project, changed fields, both effects); totals correct on re-read.
- C: rule_to_approval applied via `POST /v1/rules/approvals (createApprovalRuleRow)`
  — approval_rules 3→4, second apply 409; en route the applier surfaced the
  route's own zod verbatim twice ("Nothing was created") on my malformed probes,
  proving the no-bypass leg live; budget_adjustment applied via
  `PATCH /v1/projects/:projectId (applyProjectPatch)` — 0.2→5, smuggled `name`
  refused with the project untouched; pending-apply refused by name; no stale
  "unapplied" claims remain.
- D: keyless demo floor (dispatch:true invoke proven by usage-row delta 19→20;
  grounded copilot answer with caveat); independent suite green as above.

**Process**: M-027 logged — four consecutive slice agents (B7b→B8b) stalled
"waiting for a monitor" that was not running (B8b with uncommitted work in the
tree); the dispatch-brief fix (foreground final suite, state numbers before
stopping) ran clean on B8c. Instrument-level setup used where the product path
was already test-pinned (one approval row bound by SQL to the use-case instance;
retest exercised the join through the API).

## Batch B9 + retest — 2026-09-05

Owner-directed from the mcp-gateway-registry gap review: build items #1 and #2 as one
slice (they share the MCP registration path and the proxy front door). ADR-0097,
migration 0103. An 8th silent workspace rollback preceded this — caught because a
delegated gap-check answered from the stale tree (M-028), not by luck of process.

**Independent verification**: fresh `regulait_test` at `6b12ab5` — **164 files / 2560
passed + 9 MinIO skips**, matching the builder's own numbers (+1 file, +25 tests);
`pnpm -r build` clean; ADR index 97 = 97; journal tail 0103, idx/when unique+ascending;
migration proven by the fresh-DB run. Pre-change baseline I captured BEFORE the build —
32 `toBe(403)` in `mcp-proxy.test.ts` — is **unchanged at 32**, confirming no entitlement
refusal was quietly converted to a 401.

**Hands-on retest** (criteria pre-written in scratchpad `b9-retest-criteria.md`; keyless
gateway :3223 on seeded `regulait_b9live`; three controllable fake upstreams serving
clean / poisoned-description / poison-only-in-nested-schema): **ALL PASS.**

| Case | Result |
|---|---|
| A1 default byte-identical | knob `off` in DB; poisoned server registers `unscanned`; proxy call 200 |
| A2 enforce holds + control | poisoned → `held`/`critical`/6 findings, call denied; clean server under the same setting → `clean`, callable |
| A3 **pre-connect** | upstream KILLED, call still returns `mcp_admission_held` (not a connection error) — nothing attempted outbound |
| A4 nested-only poison | held at critical; `where` = `inputSchema.properties.q.description` |
| A5 **drift re-holds** | a clean, approved server whose upstream changed → `held` automatically, no admin action |
| A6 clear path | no reason → 400; non-admin → 403; admin+reason → 200, reason/actor/timestamp persisted; audit rows `mcp-admission-held` (deny), `mcp-admission-drift-reheld` (deny), `mcp-admission-cleared` (allow); cleared stays cleared on the same manifest |
| A7 invisibility | held server → `{"tools":[]}` |
| findings hygiene | grepped stored findings for `id_rsa` / `attacker.example` / the injection string — clean; counts+locations only |
| B1 **metadata honesty** | both advertised credentials verified genuinely accepted (API key throughout; session cookie proven by login → 403-not-401). `authorization_servers` omitted with a written reason; DCR false; cookie excluded from `bearer_methods_supported` per RFC 6750 |
| B2/B4 challenge | no credential → 401 + `Bearer realm=…, resource_metadata=…`; bad credential → adds `error="invalid_token"`; scoped metadata URL resolves |
| B3 no leak | authenticated-but-refused → 403 with **no** challenge (both a gate refusal and an in-protocol entitlement denial) |
| B5 no overclaim | bogus serverId → 200, never 404: the metadata path cannot enumerate the registry |
| C1 demo floor | dispatch invoke 200 with usage row 19→20 (M-026: verified by the row, not the status code) |

**One false alarm, resolved by control**: seeded `repo-tools` returned 500. Its URL is
`http://127.0.0.1:9/...` (discard port, unreachable by design) and the same 500 occurs with
`mcpAdmissionMode=off` — pre-existing, not a B9 regression.

**Three probe errors, all mine, all caught before reporting** (M-004/M-026 discipline
working): wrong settings path (`/v1/org-settings` vs `/v1/org/settings`), missing
`x-regulait-csrf` header, and `username` vs `identifier` in the login body. No new mistake
class — these are instances of rules already logged.

**Residues for the ledger**: knob ships `off` (inert until an operator opts in; recommended
path `log` → review → `enforce`); no SPA surface for the review queue; no scheduled re-scan;
`MCP_ADMISSION_SCANNER_VERSION` bumping is convention nothing enforces; `openapi.json` and
the api-client were regenerated, so that package needs a rebuild before its own drift test
passes locally.

## Batch B10 + retest — 2026-09-06

Owner-directed "identify the pending items and let's start building". Buildable-now set was
seven; picked the three that were unambiguously unblocked and did not require reversing a
prior decision. Sequential, because they collide in schema/shared-zod. ADRs 0098–0100,
migration 0104.

- **B10a** (`32653b8`+`79f567b`, ADR-0098, migration 0104): `api_keys.expires_at` + two org
  dials, enforced in `authenticate()`; expired ≠ revoked in error and audit; ceiling refuses
  rather than clamps.
- **B10b** (`d137650`..`6d155ae`, ADR-0099, no migration): credential scrub sited at
  ADR-0060's `appendChainedAuditRows` chokepoint — covers raw inserts by construction;
  redaction preserves correlation; scrub precedes hashing.
- **B10c** (`98ea6eb`+`e052982`, ADR-0100, no migration): off-by-default ADR-0064 sweep
  re-adjudicating through the live path, closing ADR-0097's "a compromised server nobody
  calls is never caught" residue.

**Independent verification**: fresh `regulait_test` at `e052982` — **167 files / 2599 passed
+ 9 MinIO skips**, matching each builder's numbers; `pnpm -r build` clean; ADR index 100 =
100; journal tail 0104 unique+ascending.

**Hands-on retest** (criteria pre-written in `b10-retest-criteria.md`, keyless gateway :3225
on seeded `regulait_b10live`): **all criteria PASS.**

| Case | Result |
|---|---|
| A5/A6 expiry, two surfaces | control 200 before → `api_key_expired` after on REST; same key at MCP → 401 + `WWW-Authenticate … error="invalid_token", resource_metadata=…` |
| expiry diagnosability | caller sees generic `unauthenticated` at MCP (correct — no credential-state leak) while the ledger keeps `api-key-refused-expired`. Posture, not omission |
| B1 audit scrub | AWS-shaped key typed into a clear reason stored as `[redacted:aws_key:20:1a5d44a2dca1]` |
| B4 chain ordering | `GET /v1/audit/verify` → `status: ok`, `firstBreak: null`, with a redacted row inside the range |
| C1 sweep | `clean` → `held|critical` with **nobody calling the server**; audited fact eligible 4 / examined 4 / adjudicated 1 / held 1 / unreachable 3 |
| D1 B9 regressions | poisoned server held on first sync; with the upstream KILLED the call still returns `mcp_admission_held`, not a connect error |
| D2 demo floor | dispatch invoke 200, usage rows 19→20 |

**Finding — recorded as S5, not patched.** The scrub covers `audit_log` only. In the SAME
request, the same operator-typed key was persisted verbatim to
`mcp_servers.admission_clear_reason`; a schema sweep found **47** free-text columns outside
`audit_log` holding operator prose. Not a failure of ADR-0099 against its scope, but its
limits list does not say so. The fix is a design choice (zod refinement on the shared reason
schemas is the closest analogue to what made ADR-0099 sound), not a patch — so it is written
down rather than guessed at.

**Second finding — the suite's exit code is unreliable.** Two unhandled `socket.destroySoon`
errors escape `mcp-admission-auth.test.ts`; the same two errors gave exit 0 on one run and 1
on the next. Local verification is this project's only gate, so this is recorded in §5 rather
than tolerated. Origin was initially misattributed (by the B10b agent, and by me when I
repeated it in B10c's brief) to `@hono/node-server` — **that package is not in this repo**.

**Process**: **M-029** logged — I judged B10a "untested" from ONE commit's `--stat`, said so,
and overwrote the 492-line suite the agent had committed in its second commit; recovered via
`git checkout` because the work had been pushed. B10a's agent was itself killed mid-slice by a
session limit and survived for the same reason. Surface ownership held: B10c was rescoped to
backend-only after confirming `apps/web/**` belongs to the local session, and the admission
review-queue page is an explicit handoff.
