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

- **2026-11-19, 00:15 UTC.** Merged and audited since the hand-over: #941, #1013, #904, #1010, #903, #1035, #744, #1019,
  #952, #1040, #902, #883, #1039.
- **Census queue (M-118):** #848 (E2) is in its turn; then #855, #861, #867, #865, #1020, #871, and later #964, #1044,
  #892, #982 once approved. After each census merge, read `KNOWN_UI_GAPS_MAX` on main and give the next builder main's
  value plus its own delta (`git diff origin/main...origin/<branch> -- scripts/preflight-ui-route-census.mjs`).
- **Non-census PRs** are released in parallel as soon as both approvals land (#1045 next).
- **Waiting on builders:** #884 (E18), #996 (E27), Codex #936 (route first on READY).
- **Usage limit:** see Status.md for the 2026-11-18 outage and the resume rule.
