# mistakes.md — the ledger of my own errors

Standing instruction from the owner (2026-08-13): track every mistake I make
building RegulAIt, so the same mistake is never made twice. Read this at
session bootstrap alongside CLAUDE.md and STATE.md.

Rules for this file:
- **Append-only.** An entry is never softened or deleted; a repeat of a logged
  mistake gets its own entry marked **REPEAT**, which is the signal the rule
  below it failed and needs rewriting.
- Every entry ends in a **rule** — one imperative sentence a future session can
  obey mechanically. A mistake without an extractable rule isn't understood yet.
- Mistakes only. Defects found in the code are findings, not mistakes; they go
  in ADRs. This file is for errors in **my process** — wrong claims, broken
  tests, bad briefs, harness accidents.

---

## 2026-08 (brand/UI session and the pillar review)

### M-001 — Asserted a browser behaviour as fact in a comment, from a guess
The skip-link focus test failed; I diagnosed "Chromium quirk", changed CSS, and
wrote a comment stating that diagnosis as fact. The real cause was my own
priming `click()` setting the document's sequential-focus start point.
**Rule: never write a causal claim into a comment until the cause is proven by
removing it and watching the failure disappear.**

### M-002 — Shipped a test that passed vacuously
The wordmark sweep "passed" because the route list was too narrow and the regex
let `RegulAIt-LLM` through on a trailing hyphen. Tightening it failed 14/15
routes — the test had been asserting nothing.
**Rule: a new test must be shown to FAIL against the defect it guards (break
the code or widen the input), and every positive assertion needs a control.**

### M-003 — Hand-computed numbers stated as measurements
8 of 13 hand-written contrast ratios were wrong, one an overclaim above AA.
Browser-measured values then found a real sub-AA colour.
**Rule: never state a computable number from mental arithmetic — measure it
with the tool that will judge it in production.**

### M-004 — Blamed the app when my test was wrong (seven separate times)
Wrong invoke body, wrong audit field names, wrong route, wrong response field,
misattributed seeded grant, invalid SSN test vector (987-65-4321 — area 900+ is
structurally invalid, so the detector was RIGHT to ignore it), and a "STILL
LEAKING" live re-probe that was my probe's bug. The app was right every time.
**Rule: when a probe fails, verify the probe against a known-good baseline
call before reporting a defect — the first suspect is my harness, not the app.**

### M-005 — `git stash` while a background agent was editing the tree
Stashing raced a subagent's writes.
**Rule: never stash or reset while any agent has the tree; use `git worktree`
for isolation.**

### M-006 — `pgrep -f`/`pkill -f` matched the invoking shell (exit 144, repeatedly)
The pattern matched my own command line and killed my shell.
**Rule: bracket one character of the pattern (`dist/mai[n].js`) so the
matcher's own command line can never match itself.**

### M-007 — Edited symbols into the wrong import block
Added audit-chain symbols to the `vitest` import instead of `./audit-chain.js`.
**Rule: after editing imports, read the whole import statement back before
running.**

### M-008 — Asserted absolute counts where earlier tests legitimately add rows
A new pii test used absolute row counts on a shared-DB suite; earlier tests
bill the same project.
**Rule: in shared-database suites, assert DELTAS around the action under test,
never absolute counts.**

### M-009 — Reused a test database with residue and got phantom 409s
User-creation 409s came from an earlier run's rows, not from the code.
**Rule: drop and recreate the scratch database before every suite run.**

### M-010 — Briefed a subagent with a wrong technical claim, stated as the goal
I told the MinIO agent to prove "overwrite and delete are both refused" by
Object Lock. Object Lock protects a VERSION, not a NAME: same-key PutObject
succeeds and a bare delete plants a delete marker. Following my brief verbatim
would have shipped the masking hole; the agent's measurement corrected me.
**Rule: a brief states the INVARIANT to protect ("verification must never read
an attacker-influenced head"), not the mechanism I assume enforces it — and
subagents must be told to contradict a brief the evidence disagrees with.**

### M-011 — Guessed API shapes instead of reading the neighbouring test first
In one session: `/v1/org-settings` for `/v1/org/settings`, `result.pii` for
`dispatch.pii`, a guessed connector payload, guessed 403/404/422 for an
attribution 400, and a reassign control that never drove the node to the
`blocked` state the kernel requires.
**Rule: before writing a test against any endpoint, read one existing test of
that same endpoint and copy its exact idioms — URL, payload, response shape,
and required state.**

### M-012 — Left a process-wide setting flipped in a shared-suite test
`org-settings.test.ts` set `defaultPiiMode: "block"` and never reset it.
Harmless under the old semantics, a 403-generator for every later file under
the new floor — caught only because I went looking for it (task #119 was this
same disease in auth/saml).
**Rule: any test that mutates a singleton (org_settings, env vars,
interception settings) restores it in the same test or an afterAll, and the
review for a semantics change includes grepping every OTHER file that touches
the knob.**

### M-013 — Watched work with a filter that could only see success
Early monitoring patterns grepped for the success marker only, so a crash
would have read as "still running". (Corrected before it bit — logged because
the pattern was written.)
**Rule: any wait-for-completion filter must match every terminal state,
failure included; silence must never be interpretable as progress.**

### M-014 — Two subagents parked on background watchers that cannot wake them
Both review agents stopped mid-task ("watchers armed", "waiting on the suite")
because they armed Monitor-style watchers on their own background runs — and a
subagent's monitors do not re-invoke it, so each sat idle until I nudged it.
The defect was in MY briefs: they never said so.
**Rule: every subagent brief that involves long-running commands must state:
never stop to wait on a monitor/watcher — poll the run's output file in a
bounded foreground loop, and do not end the turn before committing and
summarizing.**

### M-015 — Nearly redid work a dead agent had already finished
The delegation-conformance agent was killed mid-turn by a model-limit API error.
Its last words were "Now the ADR and README row", which read as "unfinished" —
but it had in fact written all four artefacts (test, ADR, spec doc, README row)
and died only before `git commit`. Re-running the brief would have duplicated
several hundred lines and burned another agent's budget.
**Rule: when a subagent dies from an API/limit/timeout error, inspect the
working tree for completed-but-uncommitted artefacts BEFORE re-dispatching —
a killed agent's last message describes its intent, never its file state.**

### M-016 — `git checkout <file>` to undo a bypass, in a dirty tree
Reverting a deliberate test-bypass edit with `git checkout apps/gateway/src/agents-connectors.ts`
threw away ~450 lines of uncommitted work in the same file, because checkout restores the
whole file from HEAD, not the one edit. Rebuilt and re-verified, but the work was gone
for a while and could have been lost entirely. (Self-reported by the agent that did it.)
**Rule: never `git checkout`/`git restore` a FILE to undo a temporary edit while that file
holds uncommitted work — reverse the exact edit with Edit, or commit first so the revert
has a floor to land on.**

### M-017 — Verified new browser specs individually, never as a suite
I added three Playwright specs and validated each on its own fresh database.
They passed. Run as a SUITE they broke five others, because the e2e suite
shares ONE seeded database and the seeded one-time password is single-use: my
specs consumed it and then set a PRIVATE new password, so every later admin
spec was locked out. The existing specs had already solved this with an
order-independent `signIn(page, email, candidates[], settleOn)` that tries the
one-time AND the shared password and settles on the shared one — I never read
one of those, only the first test of phase2, which is the one spec that
legitimately asserts the raw one-time flow.
A separate instance of the same blindness: shipping the ADR-0077 template
gallery added five "Template name for X" inputs to a page whose existing test
used `getByLabel("Name")`, turning a unique locator into six matches.
**Rule: after adding a browser spec OR adding form controls to a page an
existing spec drives, run the WHOLE browser suite before claiming it verified
— and for shared-fixture suites, copy the order-independent sign-in helper the
later specs use, never the bootstrap flow the first spec asserts.**

### M-018 — A new spec file's NAME is part of its blast radius
After fixing the sign-in collision, two specs still failed in the suite
(phase4's rule test, phase5's "allow-list starts empty") though both passed
alone and paired with mine. Cause: the suite shares one seeded database and
several specs assert GLOBAL state ("starts empty", "this row is the one I
made"). My files sorted alphabetically ahead of the established suite, so they
mutated that state before those assertions ran. Renaming mine to sort last
took the suite from 2 failures to 107/107 — the specs' CONTENT was never the
problem, their POSITION was.
**Rule: in a shared-fixture e2e suite, name a new spec so it runs AFTER the
established ones (a `zz-` prefix here), and treat file order as part of the
fixture contract — a spec that asserts global emptiness can only be protected
by nothing running before it that writes.**

### M-019 — REPEAT of M-014: the no-parking rule was in the brief, and the agent parked anyway
The L4 discovery agent's brief contained M-014's rule word-for-word ("never park
on a watcher/monitor — poll in bounded foreground loops; do not stop until
done") — and the agent still ended its turn with "the monitors will notify me",
which they never can. A rule stated once in a long brief's process section does
not survive contact with the moment a long suite is launched: the agent reaches
for the harness's ergonomic default (background + watcher) because that is what
the tooling suggests in the moment. The fix is mechanical, not exhortative.
**Rule: a subagent brief must make parking impossible rather than forbidden —
instruct that long commands be run as a SINGLE FOREGROUND Bash call with an
explicit timeout (10 min is allowed) that tails the log itself, state that the
Monitor/background path is OFF-LIMITS for suite runs, and place that
instruction INSIDE the verification step it applies to, not in a separate
process-rules section.**

### M-020 — "run it last" was a Playwright rule; vitest orders files by SIZE
L24's gateway test created campaign/SoD rows; two earlier files asserted the
global "none has ever existed" posture statements. The agent applied M-018's
rule — rename to sort last — and its suite went green. But M-018 is about
Playwright, which runs files alphabetically; the gateway vitest suite runs
sequentially in SIZE order (fileParallelism: false, default sequencer), so the
rename changed nothing and the green run was luck: my independent re-run of
the identical commit had the "polluting" file run first and failed the
emptiness assertion. Two lessons. First, a nondeterministically-ordered green
suite does not prove order-independence — only a run forcing the hostile
order does. Second, the emptiness assertions themselves were M-008 debt from
the day they were written ("only this file creates rows" is a claim about
every FUTURE file, which no present file can make). Fixed by pinning the
zero-state statements inside a rolled-back transaction that empties the
tables (order-proof, touches nothing durable) plus a two-way consistency
check on the live endpoint.
**Rule: a shared-DB test may assert global emptiness ONLY inside a
rolled-back transaction that creates that emptiness; file naming is an
ordering tool in Playwright alone, and any "only this file writes X" comment
must be treated as already false.**
