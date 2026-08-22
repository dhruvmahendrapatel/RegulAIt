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
