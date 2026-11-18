# Build status

## Current state (2026-11-18)

- **Rule 15 (finish before starting)** is in force for every builder lane. Each lane works only its oldest open PR, and
  no new PRs or slices are started.
- **Queue:** about 90 open PRs. Target: under 50, then lift rule 15 a few lanes at a time, E45 (RPA) code first.
- **Sessions:** phasing down to 10 at once (D-2026-11-18-04). Lanes are archived as each says "LANE DONE".
- **CI:** about 16 runs queued. Codex C1 (#936, build the gateway once for CI) is the main speed-up and is reviewed
  first.
- **Merge loop:** runs from the master's scratchpad. It merges only PRs listed in released.txt, at the exact released
  head.

## Pending

| Item | Owner | Since | Notes |
|---|---|---|---|
| #1004 picomatch no-fix gate | merge loop | 2026-11-18 | Released at 07ca5186. After it merges, every lane failing only "Dependency audit" merges main once |
| #973 E44 Purview labels | R3 + Xtyd8 | 2026-11-18 | First review |
| #941 E31 on-device rules | WaRPg + a3BYi | 2026-11-18 | Delta re-review |
| #883 E20 agent risk score | WaRPg + Xtyd8 | 2026-11-18 | Delta check of the conflict merge |
| #1010 E45 ADR-0364 RPA | E45 | 2026-11-18 | ADR only until rule 15 lifts |
| #936 Codex C1 CI build-once | Codex | 2026-11-18 | Route first when READY |
| #1009 flaky SAP idempotency test | triage-low | 2026-11-18 | F2 × S2 = 4; code left alone |
| S7 RLS PM-tables batch push | S7 | 2026-11-18 | Owner approved the push (D-2026-11-18-08); confirm that S7 pushed |
| E10 rehearsal | parked | 2026-11-18 | Owner deferred the rehearsal role (D-2026-11-18-09) |

## Done log (newest first)

- 2026-11-18: #898 per-route bundle budgets merged; #881 governed vendor-agent control merged.
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
