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

## M-027 (2026-08-23) — four slice agents in a row stalled "waiting for a monitor" that was not running

B7b, B7c, B8a and B8b's build agents all ended their turns mid-verification with
words like "waiting for the monitor notification" — but the harness notifies the
coordinator precisely when an agent has NO live background children, so the
monitor each believed was armed was already gone, and nothing would ever wake
them. Worse, B8b stopped with its entire slice UNCOMMITTED in a container that
silently rolls back working trees. Each stall cost a coordinator round-trip
message to resume; the fix that actually worked (B8c ran clean) was putting it
in the dispatch brief: run the final suite IN THE FOREGROUND of the turn, do not
background it, and end the turn only after stating the numbers.
**Rule: a subagent's definition-of-done must be reachable inside a single turn —
instruct agents to run terminal verification in the foreground and to state the
result before stopping; treat any agent report of "waiting for a monitor/
notification" as a stall to resume immediately, not a state to wait on.**

## M-028 (2026-08-23) — a subagent answered a research question from a rolled-back tree, confidently and in detail

Asked to gap-check RegulAIt against an external project's feature set, an Explore
agent returned a meticulous 12-row verdict table with file:line citations — built
entirely against a **months-stale snapshot**. The container had rolled the working
tree back (8th occurrence) to `a11fdc5`, where `docs/decisions/` stops at 0064;
the agent duly reported "there is no ADR-0066", "virtual keys is not a shipped
concept", and NONE verdicts for capabilities that ADRs 0065–0096 had long since
built. Nothing in its output looked wrong: the citations were real, the greps
were real, the tree was just old. I caught it only because one claim contradicted
something I had probed myself hours earlier (`usage_events.virtual_key_id`, in
the B7a retest) — i.e. by luck of overlap, not by process.
M-022/M-025 made the coordinator verify HEAD before diagnosing missing content;
this extends that to DELEGATED reads, where the coordinator never sees the tree
the agent saw.
**Rule: any subagent that reads the repo must verify `HEAD == origin/<branch>`
(and one cheap invariant such as the ADR file count) BEFORE reading, and must
print the HEAD sha in its answer as proof. A research verdict with no stated HEAD
is unciteable — re-run it. Absence of evidence from an unverified tree is not
evidence of absence.**

## M-029 (2026-09-06) — I judged a slice "untested" from ONE commit's stat, and overwrote the tests

The B10a agent was killed mid-slice by a session limit. Reviewing what survived, I
ran `git show --stat` on the FIRST of its two commits, saw no `.test.ts`, and
concluded "the implementation shipped but there are no tests — this slice is
unverified enforcement code." I said so to the owner, wrote a 186-line
replacement test file, and only discovered the truth when `git status` reported
the file as **M** rather than untracked: the agent had written a thorough
492-line suite (16 cases, several stronger than mine — the key-exchange bypass
path, default-above-ceiling coherence, all four lifecycle states) and committed
it in the SECOND commit, which I never inspected. My file had clobbered it.

Worse, the evidence was in front of me and I read it backwards. The module comment
said the invariant was pinned by `api-key-expiry.test.ts` "rather than trusting
it", and I treated that as an agent citing a test it never wrote — an accusation
of dishonesty — when it was a plain true statement and my check was the thing that
was incomplete. Nothing was lost only because the work had been pushed, so
`git checkout` restored it.

**Rule: to judge what a multi-commit slice contains, diff the whole RANGE
(`git diff --stat <base>..<head>`, or `git log --stat`), never one commit; and
before writing any file, establish whether it already exists. When an artifact
references another by name, that is evidence FOR its existence — go look for it
before concluding the reference is false.**

## M-030 (2026-09-07) — I "corrected" a right attribution into a wrong one by checking only direct dependencies

PENDING §5 recorded that the suite's `TypeError: socket.destroySoon is not a
function` originated in `@hono/node-server`. In an earlier session I decided that
was a misattribution, and edited the file to say so with a flat factual claim:
*"that package is not in this repo at all."* I had checked the workspace
`package.json` files, found no `hono`, and stopped.

It is in the repo. It is a **transitive** dependency of
`@modelcontextprotocol/sdk@1.29.0` (`pnpm-lock.yaml:4223`) — which is exactly why
no workspace manifest mentions it. A single `grep` of the lockfile, or one
`pnpm why`, would have shown it. Instead the stack frame proved it during the
B13a retest: `Timeout.forceClose (@hono/node-server/dist/index.mjs:390:14)`.

Two distinct failures, and the second is the worse one. First, I searched the
wrong surface — direct dependencies are a subset of what is installed, so their
absence proves nothing about presence. Second, and this is the real error, I
published a **universal negative** ("not in this repo at all") on the strength of
one narrow check, and I published it as a *correction*, which carries more
authority than an ordinary claim: it tells every later reader that the question
was examined and settled. A wrong correction is worse than the wrong thing it
replaced, because it forecloses the check.

The same shape appeared twice more in the same review. I told the owner
`boot.ts`'s `/app` and `/admin` banners "now 404" — they 302 to `/ui` and resolve
200; I had inferred the consequence from the ADR that removed the routes instead
of issuing the request. Both claims were about observable runtime behaviour, and
both would have cost one command.

**Rule: to claim something is ABSENT, search the surface where it would actually
appear — for a dependency that is the lockfile or `pnpm why`, not the manifests.
Never assert a universal negative from one narrow check. And hold a CORRECTION to
a higher standard of evidence than the claim it overturns, because it is read as
settled: verify it directly, and if the direct check is cheap (one command, one
request), run it rather than reasoning to the consequence.**

## M-031 (2026-09-07) — the same error as M-030, three hours later, in the same review

Writing the F05 brief I stated that `mcp-proxy.test.ts` "currently passes while
doing exactly that" — executing arguments an approver never signed — and put the
same claim into `PENDING.md`. It is false. That test queues its approval with
`{text:"hi"}` and executes with `{text:"hi"}`; its retry with `{text:"again"}` is
refused by **single-use consumption**, not by any payload check. The suite never
exercised the hole in either direction. The build agent read the file, found the
claim wrong, and added a genuinely mismatched attempt instead of editing
assertions to match my description — which is the only reason the new test proves
anything.

The finding itself was real, and that is what makes this worth its own entry: a
true conclusion reached through a fabricated intermediate. I inferred what the
test demonstrated from its *shape* — an approval, then two calls with different
arguments — without reading the arguments the first call passed. Had the agent
trusted the brief, it would have written a test that asserted my story rather
than the behaviour.

This is M-030's rule (published a claim I had not directly checked, in a form
that reads as settled) recurring **within the same session in which I wrote
M-030**, against a file I had open. Writing the rule down did not transfer it,
because I filed M-030 as being about *dependency resolution* rather than about
the move underneath it: reasoning to what an artifact must contain instead of
reading it.

**Rule: when a brief or a status file asserts what a specific test, file or route
DOES, quote the lines that show it — reading them at the moment of writing, not
recalling them. If the claim is worth stating as fact to another agent, it is
worth the one command that confirms it. And when logging a mistake, name the
MOVE, not the domain: "I did not check the lockfile" is a fact; "I asserted
content from structure" is the rule.**

## M-032 (2026-09-08) — I silenced my own instrument, then nearly reported its silence as a result

Verifying N1, I ran the gateway suite twice and got **159 of 173 files "failed"**
with 2464 tests skipped, on databases I had just created. The tree under test was
sound. Postgres was simply **down** — every database-backed `beforeAll` threw
`ECONNREFUSED 127.0.0.1:5432`, and the 233 tests that passed were the pure ones
needing no database.

I could not see that from the run, because my own harness hid it. I had written
the setup step as:

```
psql ... -c "DROP DATABASE ..." -c "CREATE DATABASE ..." >/dev/null 2>&1
```

`2>&1` to `/dev/null` discarded the connection error from the one command whose
failure invalidates everything after it. The suite then ran against a database
that did not exist, and reported that as 159 failing files.

Two things make this worse than an ordinary slip. First, I had **already written
the rule** — `TESTING_CHECKLIST.md` gained a preamble two batches earlier saying
*"a run reporting mass skips is a dirty database, not a passing suite"*. I had
considered only a **dirty** database, not an **absent** one, so my own warning
did not fire for me. Second, this session's entire value has been catching
results that look like findings but are artefacts; had I pasted "159 files
failed" into a report, I would have manufactured exactly the kind of false
regression I keep catching in others' runs — on somebody else's correct work.

The near-miss was luck of temperament, not process: the number was implausible
enough that I looked at a failure body instead of reporting the summary. A
slightly *less* dramatic wrong answer — say 3 files failing — would very likely
have been reported.

**Rule: never discard stderr from a setup or precondition step. Redirecting a
command's errors is only ever acceptable for a command whose failure does not
change the meaning of what follows. Every verification harness must make its
preconditions ASSERT rather than assume: probe the dependency, fail loudly, and
abort — a run that cannot distinguish "the code is broken" from "my instrument is
absent" produces no evidence in either direction. And when a result is dramatic,
that is the moment to check the instrument first, not the code.**

## M-033 (2026-09-09) — my non-vacuity technique cannot see a vacuous assertion, and I had been claiming it could

Across five batches — B13a, B14, N1, N2 and S9 — I have certified work as
non-vacuous the same way: neutralise the control in place, re-run, and confirm
the relevant tests redden. I treated a red as proof the test was doing its job,
and a green on an "unchanged behaviour" case as the correct negative control.

S9 showed the gap. Of three fixed sites, only one reddened. The other two stayed
green **while demonstrably reading the wrong row** — verified, not assumed. The
sharpest is `credentials-keys.test.ts`: it asserts
`not.toContain("sk-nina-own-key")` against a row fetched by an unordered read. A
row belonging to *another user* satisfies that assertion trivially. The test
exists to prove one user's stored key never leaks into another's ciphertext, and
it was capable of proving that about a row belonging to nobody in particular.

**Reverting a fix tests whether the FIX is load-bearing. It cannot test whether
the ASSERTION is.** And the two failure modes are indistinguishable from the
outside: a vacuous assertion staying green under a probe looks exactly like a
correctly-unaffected negative control. Every "N of M reddened, the rest correctly
stayed green" I have reported this session carries that ambiguity, and I did not
flag it once, because the technique had been working and I never asked what it
could not see.

I did not manufacture a red to reach 3-of-3, which is the failure this could
easily have become — the pressure to do so was real, since a clean sweep reads
better than a ragged one. But the honest report is only half the fix.

**Rule: a non-vacuity probe answers "is this fix load-bearing?", never "is this
assertion discriminating?" — treat them as two separate questions. When a probe
leaves a test GREEN, do not record it as a passing negative control until you
have checked WHY: confirm the neutralised code path was actually exercised and
that the assertion would fail on wrong data. Where an assertion is a negative
(`not.toContain`, `not.toBe`, `toBeNull`), suspect vacuity first — a negative
assertion is satisfied by the absence of a thing, which is exactly what reading
the wrong row gives you.**

## M-034 (2026-09-09) — deferred claims are the least-verified content in this repo, and I verify proportionally to what changed

ADR-0109 found that ADR-0107's deferred-sites table says `data_key_state` is "a
singleton by convention only". It is not: migration **0075** already gives it
`id text PRIMARY KEY DEFAULT 'singleton'` **plus** `CHECK (id = 'singleton')` —
the identical shape `org_settings` uses. The claim was wrong when written, and I
verified ADR-0107 without catching it.

My review was proportionate in the ordinary sense: I ran the suite, confirmed the
headline fix against the schema, and read the honest-limits section. What I did
not do — and would not normally do — is check each of eleven claims about work
that was **deliberately not done**. And that is the pattern worth naming.

**Verification effort in this project tracks what CHANGED. Deferred items change
nothing, so they attract none — while being exactly the material that future
batches are planned from.** A fixed line of code is exercised by a test the same
day. A sentence saying "this other thing needs a constraint" is exercised by
nobody, possibly for months, and then becomes a work item somebody scopes from.

This is the third instance. F08 caught two stale rows in `PENDING.md`'s backlog
inventory — the S3 Object-Lock sink described as unwired when `audit-chain.ts`
imports `GetObjectLockConfigurationCommand`, and copilot proposals described as
having no applier when B8c had built one. An external reviewer was misled by both.
Now a deferred-work table in an accepted ADR. Three for three: the errors are not
in the code, they are in the prose describing work not yet done.

**Rule: when an artifact defers work, the deferral's factual premise is a claim
like any other and gets checked at the moment it is written — "X lacks a
constraint", "Y is unwired", "Z has no applier" are all one command. And when
picking up deferred work later, re-verify its premise BEFORE scoping from it:
the reason the premise survived unchallenged is that nothing executes prose. The
cheapest place to catch this is the batch that writes the deferral, not the batch
that inherits it.**

## M-035 (2026-09-19) — a POSITIVE assertion can be vacuous too, if it watches one of several producers

M-033 recorded that a negative assertion (`not.toContain(secret)`) is satisfied by
an empty column, a missing row or a capture that never happened. S14 found the
mirror image, and it is the more dangerous one because it *looks* like a strong
test.

ADR-0112 scrubs conversations at the presentation boundary and must leave the
**model-bound replay** untouched. The guard for that asserted the provider
received the original text, and it passed **10 of 10** — while a deliberate
mis-siting probe had the provider being handed redacted text.

The cause: the invoke path has **two** model-bound sources and only one runs per
dispatch. With compaction eligible the wire comes from
`ConversationContext.messages` via `prepareConversationContext`; with the caller
on optimizer `passthrough`, compaction is skipped and the wire is
`ConversationContext.history`. The guard watched the first. The second was
silently broken and nothing went red.

It was caught only because the probe was written as "mis-site the scrub on path X"
rather than "remove the scrub" — a probe aimed at a *specific* producer, not at
the control as a whole. A blunter probe would have left it green and the ADR would
have shipped a guarantee it did not hold.

**Rule: when a test pins "X is unchanged" or "X still receives the real value",
first ENUMERATE the code paths that can produce X, then assert each one — and
write at least one probe per path rather than one probe for the control. A guard
covering one of several producers passes while another is broken, and a positive
assertion is no protection against that: it only proves the path it happens to
exercise. Ask "what else could have produced this value, and would my test have
noticed if that one broke?"**

---

## M-036 (2026-09-19) — I attributed a product rule to an ADR that never contained it, and the citation is what stopped anyone revisiting it

ADR-0110's Honest limits recorded a gap I was leaving open — a re-scan re-opens
the backup LEDGER row but never the FINDING — and excused it as **"pre-existing
ADR-0017 behaviour"**. STATE.md then repeated the attribution, and so did
PENDING.md's S13 entry, quoting a rule in quotation marks: *"a re-scan never
resets a finding's status"*.

**ADR-0017 does not say that, and never did.** Its only idempotency claim is that
*a re-scan never duplicates a ledger row* — a statement about **rows**, not about
**status**. The rule I quoted lived in exactly one place: an inline comment in
`apps/gateway/src/infra.ts` (line 883 at `48de1f0`). I had put quotation marks
around a code comment and a decision record's number around a line nobody decided.

**Why it cost something rather than nothing.** A rule attributed to an ADR reads
as *decided* — weighed once, by someone, for a reason recorded elsewhere — so the
honest move when you meet it is to respect it. The same rule sitting in a code
comment reads as *how it happens to work*, which invites the question "should it?"
By citing ADR-0017 I converted the second into the first, and S13 sat open for a
week behind a decision that had never been taken. It was caught only because S13's
brief told the agent to verify the premise; a brief that said "implement S13 as
filed" would have inherited the error and cited it again, which is how a
misattribution becomes load-bearing.

This is M-034's shape in a new place. There the lesson was that a *deferred* claim
is the least-verified content in the repo; here it is that a *citation* is, because
a reader's whole reason for not checking it is that it looks checked.

**Rule: before writing "pre-existing <ADR-NNNN> behaviour", or putting a rule in
quotation marks and a reference beside it, GREP THAT ADR FOR THE CLAIM. If the
text is not there, say where the rule actually lives — "an inline comment in
`<file>:<line>`" is a perfectly good provenance and an honest one, and it tells
the next reader the thing the ADR citation actively hides: that nobody has
decided this yet.**

---

## M-037 (2026-09-20) — a fixture resolved by a NON-UNIQUE natural key binds to another file's row, and "not 200" cheerfully accepts the wrong refusal

ADR-0117 had to prove that international PII is enforced on the compat/IDE
path. The test posted to `/v1/messages` with `model: "mock-balanced"` and
asserted `expect(res.statusCode).not.toBe(200)`.

It passed. It was not testing what it claimed.

The gateway's suite shares one database across files. Another file
(`redteam-depth.test.ts`) leaves an enabled agent — `rtd-subject` — carrying
the **same model string**. ADR-0020's tie-break for a duplicated model id is
deterministic and correct (lowest tier, then oldest `createdAt`, then id), and
it selects that foreign agent. This test's user has no grant on it, so the
route returns **403 `agent_denied`** — a refusal with nothing whatsoever to do
with PII, which satisfies `not.toBe(200)` perfectly.

So the enforcement claim on the IDE path had never once been exercised in a
full-suite run. **In isolation it passed for the right reason; in the suite it
passed for the wrong one** — the worst combination, because the isolated run is
the one a developer reaches for when something looks suspicious.

Two things make this its own entry rather than a restatement of M-026:

1. **The trap is the LOOKUP, not the assertion.** M-026 says verify by the row
   rather than the status code. Here even a careful author can pick a fixture
   by what looks like an identifier — a model name, an email, a slug — and in a
   shared database that key is not unique, so the *subject under test* silently
   becomes someone else's row. ADR-0107 recorded this shape for unordered
   single-row reads in **product** code; this is the same bug wearing a test's
   clothes, and a deterministic, correct tie-break is what delivers it.
2. **The weak assertion is what conceals it.** A refusal-shaped test is the
   easiest place in a codebase to accept the wrong reason, because the happy
   path is the one everybody scrutinises.

It surfaced only because the assertion was being strengthened for an unrelated
reason — to name the PII category rather than accept any non-200. The
strengthening failed, and the failure was the finding.

**Rule: in a suite that shares a database, resolve every fixture by an
identifier YOU created — an id, or a per-run unique token — never by a natural
key another file could also be using. And when a test asserts a refusal, assert
WHICH refusal: `not.toBe(200)` and `not.toBeNull()` are the same false comfort
as `not.toContain()`, satisfied by any outcome of the right shape. Ask "what
else in this database answers to the name I just used?"**

---

## M-038 (2026-09-20) — a passing suite is not a typecheck, and I treated it as one

ADR-0120's test file inserted a `config_versions` fixture with
`createdByUserId`. The column is `authorUserId`. There is no such field.

It passed. Not "passed a narrow run" — it passed **the full 2,819-test suite,
exit 0**, twice, and I had already started writing the ADR's verification
section around those numbers.

Two things had to line up. Vitest transforms through **esbuild**, which strips
types and never checks them, so nothing in the test run reads the schema type
at all. And **drizzle silently dropped the unknown key** rather than throwing,
so the insert succeeded with a null author and the row the test needed existed.
The fixture was wrong in a way that could not affect the assertion it supported.

The process error is mine and it is simple: after adding a new test file I ran
the suite and moved on. I had run `tsc` several times earlier in the same batch
— on the implementation — so "typecheck is clean" was true when I last checked
and I carried it forward past the point where it stopped being true. It was
caught only because the verification checklist runs build and tsc *after* the
suite, and even then I had piped both to `/dev/null` and read the exit codes,
which is the only reason I noticed rather than reporting green.

**Rule: a test file is CODE and gets the same gate as code — run `tsc --noEmit`
after adding or editing one, not just the suite. And never carry a "typecheck
passed" from earlier in a batch across a file you have since written: the
question is not whether it passed once, it is whether it passes NOW. When
reporting suite/build/typecheck together, read all three results — a suppressed
non-zero exit is worth more than a green summary line.**

## M-039 (2026-09-24) — I reused a uuid column for a value that is only sometimes a uuid, and built the fixture from the case that never differs

ADR-0120 widened policy simulation from ABAC policies to approval rules and rate
limits. The existing flip table had `policy_id uuid`, which was right for what it
was built for: ABAC simulation writes `decision.policyId`, always a real
`abac_policies` row. I reused that column for the rule path's
`Decision.ruleId` — and a kernel rule id is a uuid only when a **stored rule row**
matched. When the kernel reaches a decision without one it hands back a
**symbolic** id (`default-deny` and its siblings). Postgres raised 22P02 on the
insert and the whole simulation returned 500.

**It failed on precisely the traffic the feature exists to serve.** A preview of a
restrictive rule over real calls is the case that produces fall-through
decisions. My fixture had one entitled caller making three allowed calls, so
every replayed decision named a stored row and the other half of the value space
was never constructed. Six tests, all green, on a shape of input that could not
reach the bug.

Two things let it through the verification I did run. The dev database is shared
across sessions, so the transcript there happened to contain only rows whose
decisions matched stored rules — the feature reads **every** `mcp_tool` audit row
in the window, not just its own fixtures, and that widening of input is exactly
what made the shared DB an unreliable witness. And the full-suite run I did do
was on that same shared database, so the file ordering that produces a
fall-through row never occurred. It surfaced only when I ran the suite on a
**fresh** database, where a different file ordering put `mcp-proxy`'s unentitled
callers into the window first. It then reproduced two runs in three, which is
what a shared-state flake looks like from the outside — and the tempting reading,
which I nearly took, was "flaky suite" rather than "real 500".

The same fresh-DB run exposed a second, milder version of M-037 in my own new
file: `adr0122-mcp-discovery` asserted a specific `registeredAs` for a server on
`127.0.0.1`. The diff keys on host, most files in the package register fixtures
on that address, and so the assertion was about which suite ran last.

**Rule: a column's type is a claim about EVERY producer, not the one in front of
you. Before reusing a typed column for a newly-widened input, enumerate what the
new producer can actually emit — and if any case differs in shape, give it its
own column rather than the case you already had. Build the fixture from the
branch that differs, not the branch you wrote first. And when a feature reads
whole-table history rather than its own fixtures, a shared database cannot
verify it: run it on a FRESH one before believing green, and treat an
intermittent failure there as a defect to reproduce rather than a flake to
re-run.**

## M-040 (2026-09-25) — I built a fixture on org-global singleton state, one batch after writing the rule that says not to

M-039 ended with: *"when a feature reads whole-table history rather than its own
fixtures, a shared database cannot verify it."* I then wrote a new test file
whose `beforeAll` called `POST /v1/compliance/packs/seed`.

`compliance_packs` is unique on `(framework, version)`. It is org-global
singleton state. `compliance-packs.test.ts` asserts that ITS seed call creates
seven packs; mine had already created them, so its seed created zero and it
failed with `expected +0 to be 7`. My file passed. The suite that broke was the
one that had been correct for months.

**The tell I walked past.** I reached for the seed endpoint because it was the
convenient way to get a pack with the exact `controlRef` I wanted to assert on.
But the thing under test was the ROUTE — that the framework is a parameter, that
evidence is project-scoped, that a missing project yields nulls — and not one of
those assertions needed the shipped catalogue. I used shared state for
convenience and paid for it in someone else's file.

The fix was to author two packs with run-unique framework names, and to assert
the shipped NIST pack's content against the exported CONSTANT instead — which
needs no database at all, so it cannot collide with anything.

A second, duller error in the same file: a `sed` that replaced only the first
occurrence of a URL left two tests still querying the framework I had stopped
seeding. One of them passed anyway (it asserted on a later call that used the
right name), so the failure pointed at the wrong test. **When a
search-and-replace is part of a fix, grep for the pattern afterwards and count
the hits** — the edit is not done because one call site changed.

**Rule: before a fixture writes anything, ask whether the row is SCOPED TO THIS
RUN or SHARED BY THE ORG. A singleton — org settings, a seeded catalogue, an
activation pointer, a CHECK constraint — belongs to every suite, so creating it
is as much an act on other files as deleting it would be. Prefer run-unique
rows; where the shipped content itself is the claim, assert it against the
exported constant rather than seeding it.**

## M-041 (2026-09-26) — I wrote a runbook command I had never run, and shipped it

Asked to add a native-Postgres path to the demo runbook, I wrote the whole
section — commands, environment variables, caveats — and committed it. Then I
went to verify it, and the very first thing I had told an operator to type was
wrong:

```bash
openssl rand -base64 32     # what I wrote
openssl rand -hex 32        # what the product requires
```

`keyBytes` (`apps/gateway/src/secrets.ts:32-35`) does `Buffer.from(key, "hex")`
and demands 32 bytes. A base64 key is 44 characters of mostly-not-hex.

**Why I got it wrong is the interesting part**, and it is not carelessness about
the code. I *did* look it up. `packages/shared/src/audit-scrub.ts` says, in a
comment about what a secret looks like, that `REGULAIT_DATA_KEY` "is base64 of
32 random bytes and looks like any other base64." I read that, believed it, and
wrote the runbook from it. `app.ts:206` says "hex AES-256 key" eleven hundred
lines from where I was reading. **Two comments in this repo disagreed and I
happened to read the wrong one** — and an implementation is not a comment, so
the only source that could have settled it was `keyBytes`, which I did not open
until the suite failed.

**What the failure looked like, which is the second lesson.** Nothing rejected
the bad key. The ADR-0063 boot gate checks key *continuity*, not *format*;
`dataKeyFingerprint` HMACs `Buffer.from(hex,"hex")`, which returns a short
buffer rather than throwing. So the gateway booted clean, printed its posture,
seeded most of the way, and then failed at the first credential write as
`500 {"error":"internal"}` — six `seed.test.ts` tests red, none naming the
cause. I initially read that as a regression in my own change. It was not; it
was my key. Recorded as **D01** in PENDING, because a product that answers an
unnamed 500 to its simplest misconfiguration has a real defect independent of
my typo.

I had also, in the same turn, told the owner the section was written "but not
executed end-to-end yet" and that I would walk it. That disclosure is the only
reason this is a small mistake instead of a live failure at a customer demo on
Monday — but disclosing that something is unverified is not a substitute for
verifying it before committing it.

**Rule: a procedure is not documentation until it has been executed. Never
commit a runbook step, install command, or env-var value that has not been RUN
in the state the reader will be in — and when a value's format is the claim,
read the PARSER, not a comment about it. Comments disagree; `Buffer.from` does
not. If a procedure must be written before it can be run, say so IN THE FILE,
not only in chat, and go run it before the turn ends.**

## M-042 (2026-09-26) — I made M-040 again, one file later, and the rule as written did not stop me

M-040 says: *"before a fixture writes anything, ask whether the row is SCOPED
TO THIS RUN or SHARED BY THE ORG."* I read that rule this session. I then wrote
a G2 test that flipped `mcpPrivateRangesDefault` — the org-settings **singleton**
— to prove that an egress refusal does not trip the new circuit breaker.

It passed alone. It failed in the full suite: `expected 502 to be 403`. Some
sibling file had left `127.0.0.1` in the shared `egress_allow_hosts` table, so
my "now it is refused" step refused nothing and the call reached the dead port
instead. One failure out of 2,889, entirely mine, on the last run before a
merge.

**Why M-040 did not stop me is the part worth writing down.** M-040 is phrased
around WRITING shared state, and I checked myself against that: I wrote the
singleton and I put it back in a `finally`, so I thought I had complied. The
defect was the other half — my assertion **DEPENDED** on shared state I did not
own. `egress_allow_hosts` I never touched at all, and it is what broke me. A
rule about writes cannot catch a test whose correctness rests on a table it
only reads.

There is a second tell I walked past. This test existed in three versions and
each one was reaching for a bigger lever: first a per-server flag, then the org
default, then the org default plus a restore. **Escalating scope to make an
assertion hold is the symptom.** The fix went the other way entirely — a literal
RFC 5737 TEST-NET-3 address, randomised per run. It is public, so the
private-range posture is irrelevant whatever the org says; it is on nobody's
allow-list; the guard refuses it without resolving or contacting anything. No
shared row is read or written, and the test cannot be broken by a sibling.

Worth noting what did work: the test was not vacuous, and the full suite caught
it. The cost was one re-run, not a false green.

**Rule (supersedes and widens M-040): a fixture must not READ shared state its
assertion depends on, not merely avoid writing it. Before asserting, ask "could
another file in this suite make this assertion false without touching my rows?"
— and if the answer is yes, change the FIXTURE, not the setup. Reaching for a
wider lever to make an assertion hold is the signal that the fixture is wrong:
the right move is almost always a value so specific to this run that no sibling
could collide with it.**

---

## M-043 (2026-09-27) — I shipped a fail-open and an auth bypass, both in code I had exempted from testing in writing

ADR-0127 shipped two proxy adapters. An independent review found both unsafe,
and neither defect was subtle.

**The Envoy adapter failed open on `deny`.** Envoy's HTTP `ext_authz` decides
from the **status code** — 2xx allow, anything else denied. `/v1/authz/check`
answers `200` for all three outcomes and puts the decision in the body, because
that is what the Kong adapter needed. So a correctly computed, correctly
audited refusal would have reached Envoy as 200 and been **admitted**, by a
deployment that believed it was governed, with a ledger row agreeing the call
was denied. That is worse than shipping no adapter.

**The Kong adapter let the caller choose who they were.** It read
`x-regulait-subject` from the request and used the authenticated consumer only
as a **fallback** — so any caller who could reach the route could be authorized
as anyone. `serverId` and `toolName` came from client headers too, so a caller
could also choose *which question was asked*: name a tool you hold, invoke a
different one.

**The rule.** *Two claims about a component I have never executed are worth
less than one run of it. If I cannot run it, I do not get to say it is safe —
I say it is unverified, and I do not ship it as an example someone will paste.*

Three things make this worse than an ordinary bug, and they are the reasons to
keep this entry long.

1. **I wrote the disclosure and then reasoned past it.** ADR-0127's own limits
   section says *"the adapters are not exercised by CI… the endpoint is tested,
   the adapters are reviewed. That is a real gap and it is disclosed rather
   than papered over."* Six paragraphs earlier the same ADR asserts *"both
   adapters fail closed."* I wrote both sentences in one sitting. Disclosing a
   gap does not license a confident claim across it — **it forbids one.** An
   honest limits section is not a payment that buys the right to assert
   anyway.

2. **The comment stated the safe rule; the line below did the unsafe thing.**
   Directly above the Kong subject line I wrote *"Kong must map its own
   authenticated consumer to a RegulAIt user UUID before here; the raw consumer
   id will not do."* The next line preferred the client's header over the
   consumer. I read that file more than once and the comment kept answering the
   question for me. **A comment asserting a property is evidence about
   intent and none at all about behaviour** — when auditing, read the code with
   the comments covered.

3. **It is M-041 again, one layer out.** M-041 is *"a procedure is not
   documentation until it has been executed."* I applied it to a runbook and
   not to an integration, because config and Lua did not feel like a procedure.
   They are: an example config is a procedure a customer executes, and this one
   would have executed a fail-open. The rule was never about runbooks.

**What it cost.** Both adapters went out in a repository that is now public,
and the Envoy one has been withdrawn rather than patched — a correct version
needs a contract change at the endpoint (status codes Envoy can act on), which
Kong's adapter would have to move with. The fix is now a design decision
instead of a config edit, which is what shipping unverified bought.

**The standing consequence.** Nothing under `integrations/` is described as
supported again until its **deny path** is exercised end to end against a
pinned container, asserting **zero upstream invocations** for every refusal
and every PDP failure. A deny path that has never been run is a deny path that
does not work.
