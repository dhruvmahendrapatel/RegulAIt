# Master hand-over

Read this first if you are taking over as the master session of the RegulAIt build. The rules are in
[RULES.md](RULES.md), the open owner questions in [DecisionLog.md](DecisionLog.md), and the live state in
[Status.md](Status.md).

## Onboarding

1. Follow the CLAUDE.md bootstrap: CLAUDE.md, `internal/memory/STATE.md`, `internal/memory/mistakes.md`, and
   `internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md`. Then read this folder.
2. **Your job:**
   - Dispatch builder and reviewer sessions.
   - Send each PR that posts `READY at <sha>` to one code reviewer and a *different* security reviewer.
   - Release a PR when it has `APPROVE at <sha>` and `SECURITY APPROVE at <sha>` at its current full head SHA and every
     check run is success, neutral or skipped. Releasing means appending `<pr> <sha>` to `released.txt` and marking
     the PR ready (`gh api -X POST repos/<repo>/pulls/<n>/ccr/ready_for_review`).
   - Let the merge loop merge it.
   - Audit every merge: its second parent must equal the released SHA.
   - Fast-forward `dhruv/active` to `main`.
3. **Scripts:** these are in `scripts/master/` at the repo root. Keep `released.txt` and the loop log in your scratchpad.
   - `scripts/master/status.sh`: one line per open PR, with head, draft flag, failing and pending checks, and the verdicts
     at the head.
   - `scripts/master/merge-loop.sh <state-dir> 7000 90` (FS-25): run with `MIN_AGE=120` in the background, with a 2-hour
     timeout. Restart it about every 1h55m and after every container restart (`pgrep -fa merge-loop.sh`). It merges only
     PRs listed in `released.txt`, at that exact head, with a merge commit.
4. **Lane briefs:** every builder brief ends with the common rules 1-15 (rule 15: finish before starting). The text is
   in Status.md, under "Common lane rules".
5. **Messaging another session:** use a one-shot scheduled task bound to that session, set a few minutes ahead. The
   limit is about 7 per minute, and a time in the past fails.
6. **Hard rules:**
   - Nothing gets a production designation or a production deploy without the owner's explicit sign-off.
   - No terraform apply and no AWS write, apart from the logged, torn-down dev rehearsal.
   - Merge commits only: never rebase, never force-push others' branches, never merge one lane into another.
   - Never cancel CI runs without the owner's yes; the owner gave it on 2026-11-18 for superseded runs only.
   - Ask the owner before deleting anything.
   - Security-checklist gaps block, whatever their score.
   - The repo is public: post nothing identifying.

## Where we left off (current master)

- **2026-11-18, 14:40 UTC.** Master hand-over at about 08:54 UTC; the new master runs the merge loop.
- **Merged and audited since the hand-over:** #941, #1013 (docs), #904 (E26), #1010 (E45 RPA ADR), #903 (E12). Every
  merge's second parent equals the released SHA.
- **Census-counter bottleneck.** `KNOWN_UI_GAPS_MAX` in `scripts/preflight-ui-route-census.mjs` (and its test pin) is
  edited by every PR that adds API-only routes, so each merge makes the others conflict. Five approved, released PRs
  are being refreshed one at a time: #744 (UI-B) first, then #902 (E1), #883 (E20), #848 (E2), #855 (E3). The waiting
  builders were told not to merge main until their turn. A computed count would remove the bottleneck; that is a
  proposal for the owner, not started.
- **Request changes, fixes pushed, waiting for READY:** #861 (E7), #865 (E15), #982 (E44), #952 (E31), #867 (E16),
  #871 (E13). On READY they return to the same reviewer pair.
- **In review:** #1019 (E26, geography risk factor).
- **Waiting on the builder:** #884 (E18), #996 (E27, three failing checks), Codex #936 (route first on READY), #1006,
  #1007.
- **Next steps:**
  1. Work the census order; after each merge, tell the next builder main's new count.
  2. Lift rule 15 a few lanes at a time once the open PR count is under 50, with E45's code first.
