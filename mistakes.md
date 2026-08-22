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

### M-021 — REPEAT of M-006: pkill -f matched the invoking shell again (exit 144)
Restarting dockerd, I wrote `pkill -f 'dockerd$|dockerd '` — the second
alternative is a substring of my own command line, so the shell killed itself,
eleven entries after M-006 recorded this exact failure with a working rule I
did not apply. The rule was fine; I reached for pkill without consulting the
ledger because the command felt too small to check. That is the failure mode:
rules are consulted for big operations and skipped for reflex ones, but M-006
class bugs live ENTIRELY in reflex commands.
**Rule: before ANY pkill/pgrep -f, mechanically bracket one character of the
pattern (`docker[d]`) or use pkill -x with the exact process name — no
exceptions for "quick" commands, which are where this always happens.**

### M-022 — "commit small, don't push" is not durable in a workspace that rolls back
This container silently reverted the working tree to an old snapshot at least
three times in one session. I adapted by telling every agent to commit in small
scoped chunks — but I ALSO told them "do NOT push" (to keep the shared branch
tidy and let me verify first). A local commit does not survive a snapshot
rollback: when the L6 agent was killed by a model limit near the end of its
task, the rollback that followed erased every commit it had made, and `git
fsck` found nothing recoverable. Hours of work vanished for a reason that had
nothing to do with the work. The verify-before-push instinct is right in a
stable workspace and wrong in an unstable one; durability beats tidiness when
the floor is moving.
**Rule: when a workspace has rolled back even once in a session, every
dispatched agent must PUSH each scoped commit to the shared branch immediately
after making it (verification then happens on pushed commits, and a bad commit
is reverted forward, never left unpushed) — and the coordinator must re-verify
its own HEAD against `origin` before every action, not only before commits.**

### M-023 — Claimed a reproduction before running the negative control
Diagnosing an order-dependent test failure, I ran the two suspect files in what
I called "the hostile order", saw green with my fix, and wrote "the pair passes
in the hostile order" — presenting it as proof the fix addressed the observed
red. Then I ran the bypass (fix reverted, same order) out of habit and it ALSO
passed: the pairing reproduced nothing, so my "proof" had been a green run with
no failing counterpart, which is exactly the vacuous evidence M-002 exists to
forbid. I corrected it in the same turn, but only because I ran the control at
all; had I skipped it, a false causal claim would have gone into the record.
**Rule: never describe a run as a reproduction until the negative control has
been run and FAILED — "it passes with the fix" is evidence of nothing without
"it fails without the fix" in the same configuration, and the two runs must be
reported together or not at all.**

### M-024 — A guard was proven only in the case where it was easy to fire
L6's live verification proved the copilot's grounded refusal by asking a
no-project user about a nonexistent object: retrieval returned zero rows, the
refusal fired, and the guard was recorded as working. Manual testing later
found the real hole: an ADMIN asking about a nonexistent entity gets a
keyword-planned query that ignores the entity, returns eight real unrelated
approvals, and the model narrates "for the Zorblatt Quantum Compliance Widget,
8 approvals were requested" — a fabricated subject attached to true numbers,
stamped `modelNarrationVerified: true`. Both the brief and the test chose the
EMPTY-retrieval case, where refusal is nearly automatic, and never the case
where plausible data exists but does not answer the question — which is the
only case that distinguishes a grounded system from a fluent one.
**Rule: to prove a guard, construct the case where the guard must fire DESPITE
plausible, real, well-formed data being available — a guard exercised only
against absent or malformed input has been shown to handle absence, not to
handle the failure mode it was built for.**

### M-025 — Diagnosed data loss from a stale filesystem, having skipped my own rule
Asked what work remained, I read `docs/product/PENDING.md`, found 126 lines with
no addendum and a last-commit date predating the day's work, and began forming
the conclusion that the concurrent local session had clobbered six agents'
updates in a bad merge. All of it was wrong: the container had silently rolled
back again, `origin` held every commit intact, and one `git fetch` would have
shown it. The galling part is that M-022's rule has two halves — agents push
every commit, AND *"the coordinator must re-verify its own HEAD against `origin`
before every action, not only before commits"* — and I had written that
sentence myself hours earlier. I followed the half that protects the work and
skipped the half that protects the diagnosis, and came within one message of
publicly accusing a collaborator's session of destroying data it had not
touched.
**Rule: treat any observation of missing or reverted content as a claim about
the FILESYSTEM until `git fetch && git rev-parse HEAD origin/<branch>` proves
otherwise — never as a claim about another author, and never report it as one;
a rolled-back workspace and a hostile merge look identical from inside the
tree.**

## M-026 (2026-08-22) — I read a 200 from a decision-only invoke as an execution, twice

During the B7 retest I "generated three project-attributed dispatches" and later
"dispatched under an active config version" by POSTing `/v1/agents/:id/invoke`
without `dispatch: true` — and took the three 200s as proof the calls executed.
They were governance PREVIEWS: the endpoint returns the decision object and
executes nothing (the ledger even says so — "a decision-only invoke still
previews mocks (it executes nothing)"). The vacuous probes then produced a
false FAIL on the brand-new usage-stamp column (all stamps NULL — because no
usage rows were ever written), and I spent four diagnostic steps auditing dist
freshness, write sites, and resolution code before checking what the 200 had
actually returned. The M-004 discipline (check the harness before the code)
eventually caught it, but the probes should never have been trusted: a probe
that generates state must be verified by the STATE it claims to generate (the
usage row, the audit row with the right shape), not by its status code.
**Rule: an HTTP 200 proves the request was accepted, not that the effect
happened — before building any conclusion on a state-generating probe, read
back the state it claims to have written; for RegulAIt specifically,
`/v1/agents/:id/invoke` executes nothing without `dispatch: true`.**
