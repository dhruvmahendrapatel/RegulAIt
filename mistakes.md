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
