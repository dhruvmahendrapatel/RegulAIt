# Build status

## Current state (2026-11-19, 23:30 UTC)

- **UI-gaps counter is computed (#1067, owner 2026-11-19).** `KNOWN_UI_GAPS_MAX` is no longer hand-set. PRs that add
  routes add their own `KNOWN_UI_GAPS` entries and merge in parallel; the one-at-a-time queue (M-118) is retired. About
  45 open PRs still carry an old MAX edit: each builder merges main and drops it when the PR next comes up.
- **Rule 15 is lifted for E45, E2, E7, E16 and UI-B** (D-2026-11-19-01, D-2026-11-19-02). Other lanes finish their
  open PRs first.
- **Reviewers:** four pairs, R2 + Xtyd8, R3 + a3BYi, R4 + S4 (new) and WaRPg + S3. Check-ins run about every 20
  minutes while the queue is busy.
- **Queue:** 67 open PRs, not counting Dependabot's.
- **Merge loop:** runs from the master's scratchpad and restarts every 7000 s. When the owner enables the merge queue,
  it switches to `gh pr merge --merge --auto`.
- **CVE-2026-97054 hotfix (#1058, 03:42-04:45 UTC).** Rule: a new advisory that turns main red gets one hotfix lane,
  released ahead of the queue.

## Pending

| Item | Owner | Since | Notes |
|---|---|---|---|
| Enable the merge queue on `main` (ADR-0252) | owner | 2026-11-07 | Steps sent 2026-11-19 23:15. `main` has no ruleset yet. About 45 pending migrations, `robots.sql` included, stay unnumbered until it's on |
| E45 S3 browser runner (ADR-0364) | E45 | 2026-11-19 | Owner go; free-form limits set (D-2026-11-19-03) |
| In review: #1065 E20, #1069 E7 | reviewers | 2026-11-19 | |
| Fixing review findings: #1060 E15, #1062 E12 | builders | 2026-11-19 | |
| Not yet READY: #1066 E1, #1056 E3, designer #1070, #1075, #1077, #1078 | builders | 2026-11-19 | #1075 over its bundle budget |
| #996 E27 fairness slice 2 | E27 | 2026-11-18 | Three failing checks |
| #936 Codex C1 CI build-once, #1006 C2, #1007 C3 | Codex | 2026-11-18 | Checks failing |
| #1009 flaky SAP idempotency test | triage-low | 2026-11-18 | F2 × S2 = 4 |
| E10 rehearsal | parked | 2026-11-18 | Owner deferred (D-2026-11-18-09) |

## Done log (newest first)

- 2026-11-19 (day to evening): #1020, #1061, #871, #892, #884, #1059 (E45 Robots S2), #982, #964, #1044, #1055,
  #1067 (computed counter) and #1068 merged, each audited (second parent = released SHA).
- 2026-11-19 (night to morning): #1045, #855, #1058 (CVE hotfix), #861, #867 and #865 merged, each audited
  (second parent = released SHA); dhruv/active fast-forwarded after each.
- 2026-11-18 (late): #1040, #952, #902, #883 and #1039 merged, each audited (second parent = released SHA).
- 2026-11-18 (evening): #1035, #744 and #1019 merged, each audited. M-118 logged.
- 2026-11-18 (afternoon): #1013, #904, #1010 and #903 merged, each audited (second parent = released SHA).
- 2026-11-18: master hand-over (about 08:54 UTC). #941 merged (82142059, second parent 3b86b4e0, audited); #973 and
  #1011 merged and audited; #880 merged. Lanes E24 and E25 archived (done, no open PR).
- 2026-11-18: #1004 picomatch no-fix gate merged at 5aacbc16 (second parent 07ca5186, audited); lanes failing only
  "Dependency audit" were told to merge main once. #898 per-route bundle budgets merged; #881 governed vendor-agent control merged.
- 2026-11-17: #940, #885, #888, #935, #921, #910, #920, #897, #896, #889, #874, #828, #899, #906, #901, #850 and #887
  merged. Every merge was audited: second parent = released SHA.

## Common lane rules (appended to every builder brief)

```text
COMMON RULES (from the master orchestrator; owner direction 2026-11-14: build the queue in parallel):
1. Bootstrap per CLAUDE.md: read CLAUDE.md, internal/memory/STATE.md, internal/memory/mistakes.md, internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md. ~12 builders work in parallel; stay strictly inside your lane's surface. Do NOT ask the owner to confirm direction: this brief is the confirmed direction. Where PENDING lists an owner question inside your lane, build with the secure default the ADR proposes and record it in the PR body as "owner question open: …".
2. Secure by default (ADR-0180), open source first (ADR-0176: search first, MIT/Apache/BSD/ISC only, pinned, air-gapped, THIRD_PARTY.md), engineering guidelines (ADR-0200), the security checklist in CLAUDE.md.
3. Collisions: new tables appended to packages/db/src/schema.ts only in your own block; migrations as unique pending/<slug>.sql per the assign-at-merge convention; never run drizzle-kit generate with a timestamp, never edit the journal, never hand-pick a migration number. Use ONLY your reserved ADR numbers. New routes: add to the route census and a KNOWN_UI_GAPS entry pointing at #453 (UI is built by a separate design builder; do not build screens). Add PENDING items as fragments under internal/fragments/ (ADR-0252), not by editing PENDING.md directly.
4. Git: branch builder/<lane-slug> from origin/main; one PR per slice, small and reviewable (split L-size lanes into 2–4 sequential PRs); merge commits only, never rebase or force-push; merge origin/main into your branch when it moves. Run touched tests + `pnpm demo:prepare` locally (full local gate if migrations or security-sensitive).
5. Open a DRAFT PR against main. When CI is green, post a PR comment "READY at <full 40-char sha>". Do NOT merge, do NOT un-draft — the master merges after independent code + security review. Address review comments by pushing fixes and posting READY again at the new sha.
6. Never: production designation, terraform apply, any AWS/cloud write, secrets in code. The repo is PUBLIC: no names, emails or anything identifying in commits/PRs/comments.
7. End every turn with a one-line status. When your whole lane is merged, say "LANE DONE".
8. OWNER (2026-11-15): "Build things quick but with perfection. Reuse code that can be reusable. Prefer open source where available and follow all our rules." Before writing anything, search the repo for an existing helper, kit component, service or pattern and reuse or extend it (no parallel implementations); then search open source (ADR-0176). Record both searches in the PR body. Build for the long term, not for the pilot.
9. OWNER (2026-11-17) — unfamiliar features: do not write an unfamiliar feature from scratch. Search GitHub for open-source projects that solve it, compare at least two approaches (licence per ADR-0176, maintenance, fit), then start. Record the comparison in the PR body.
10. OWNER (2026-11-17) — bug triage: rate each bug 1–10 for how often it would happen (F) and 1–10 for how bad it would be (S). If F×S < 5, file it as a GitHub issue (label `triage-low`, scores in the body) and leave the code alone. Do not design for rare or future cases nobody asked about. Put F, S and F×S next to every bug you fix or file. Reviewers: findings with F×S < 5 are issues, not blockers.
11. OWNER (2026-11-17) — finish the whole job before you stop; do not offer to continue, continue. Ask the master before deleting anything (files, branches, tables, tests, routes) — say what and why and wait. End your lane with a recap for someone who saw none of the work: key points first, plain words.
12. OWNER (2026-11-17) — state machines: where your change touches a status/lifecycle field, make the states and allowed transitions explicit (one declared table or machine, reused, not scattered if/else) so it improves user, developer and agent experience together, without breaking existing behaviour or data. Lane E29 owns the app-wide audit; do not refactor machines outside your surface.
13. OWNER (2026-11-17) — clarifications: (a) security-checklist gaps stay blocking whatever their F×S score; (b) the master may approve deletions that replace duplicate code with an existing shared module (as a reviewer asks); deleting files, data, tables, branches or features still goes to the owner via the master.
14. OWNER (2026-11-17) — CI throttle: at most ONE open PR per lane in review at a time. Finish and merge it before opening the next. Do not open a second PR while one is open; a follow-up that truly depends on the open one may be prepared on a branch but not pushed as a PR until the first merges. Never close or delete PRs or branches to meet this (ask the master).
15. OWNER (2026-11-18) — finish before starting: the queue (90 open PRs) is growing faster than it merges. Until the master lifts this: (a) work ONLY your lane's oldest open PR (the one furthest through review) until it merges. Do not push to your other open PRs; every push to any PR starts a full CI run. (b) Open no new PRs and start no new slices. (c) Merge origin/main into your active PR only when it conflicts or a check needs it, not on every main move. (d) When your active PR merges, bring your next oldest PR up to date with main and post READY.
```
