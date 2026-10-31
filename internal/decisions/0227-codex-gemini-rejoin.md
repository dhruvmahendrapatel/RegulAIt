# ADR-0227: Codex and Gemini rejoin; Codex may build, Gemini audits

- **Status:** Accepted (owner, 2026-10-31)
- **Date:** 2026-10-31
- **Deciders:** owner. In the master session on 2026-10-31 the owner said: "setup a new agent coordination file - I
  added codex and Gemini on the project again." Asked how the work should be split, the owner chose "Codex builds
  too", and for check-ins chose "New file, docs-only now".
- **Amends:** [ADR-0191](0191-claude-sole-builder.md), decision 1 (Claude as the only builder). Its other decisions
  still stand: independent reviewer agents, specification-only vectors, and web UI ownership by default.
- **Supersedes as the live board:** `internal/process/AgentCoordination.md`, which stays retired and is kept as a
  record.

## Context

ADR-0191 retired Codex on 2026-10-10 and made Claude the only builder. Since then the build has run as one Claude
master session that dispatches Claude builder and reviewer cloud sessions, works with a laptop designer session, and
relays to the suite agent through issue #453. The old three-agent board, `AgentCoordination.md`, and its
`pnpm checkin` tooling (`scripts/coordination.mjs`) still point at the 10-05 demo state.

On 2026-10-31 the owner added Codex and Gemini back to the project. The demo code freeze is the same day (23:59
UTC), so whatever they take on starts under the freeze.

## Decision

1. **Codex is a builder and a reviewer.** It may take builder lanes on its own branches, under the same rules as a
   Claude builder session:
   - one lane per branch, named `codex/<lane>`;
   - one draft PR per lane, titled with a `HOLD` prefix;
   - a BUILDER REPORT comment when CI is green.

   It never merges, never marks a PR ready, and never changes a PR's title or draft state. Release and merge stay with
   the Claude master. Codex may also be the independent reviewer of a Claude lane, and a Claude reviewer may review a
   Codex lane. ADR-0191's independence rules apply either way: fresh context, the builder's report read only after the
   reviewer's own findings, and never review your own lane.
2. **Gemini audits and writes documents only.** It records product, UX and gap audits in markdown, in its own audit
   files under `internal/reviews/` and its section of the board. It never edits code, configuration, data, migrations,
   CI, CLAUDE.md, STATE.md or the ADR index.
3. **The Claude master stays the dispatcher.** It:
   - assigns lanes and reserves migration and ADR numbers;
   - renumbers migrations at merge, under the M-108 rule in `CONTRIBUTING_PARALLEL_SESSIONS.md` §4.1;
   - releases a PR only on an independent "APPROVE at <sha>" with green CI;
   - audits each merge;
   - is the only agent that edits `STATE.md`, the ADR index and the board's lane table.
4. **A new, current-state board.** It lives at
   [`internal/process/AGENT_COORDINATION.md`](../process/AGENT_COORDINATION.md). Each agent edits its own live-status
   row in place and its own inbox. The board holds only current state, and its history is in git. Root `AGENTS.md`
   and `GEMINI.md` point Codex and Gemini at CLAUDE.md and the board, so both load the project rules automatically.
5. **Check-ins are by hand until after the demo.** `scripts/coordination.mjs` still targets the retired file.
   Repointing it at the new board is a code change, so it waits until the freeze lifts.
6. **The demo freeze binds every agent.** Until the owner lifts it, no product code merges except a demo blocker the
   owner approves. Codex and Gemini start with reviews and audits; Codex builder lanes open only after the freeze
   lifts or with the owner's explicit OK.

## Consequences

- **Every project rule applies to Codex and Gemini as written.** That covers:
  - CLAUDE.md and the suite rules;
  - secure by default (ADR-0180) and open source first (ADR-0176);
  - the security checklist and the engineering guidelines (ADR-0200);
  - the migration rules and the standing production guardrail;
  - the banned words, and no secrets or model identifiers in the repo.

  A Codex lane that breaks a rule is a review finding, the same as for a Claude lane.
- **Migration and ADR numbers are reserved by the master only.** An agent that picks its own number collides
  silently, as the hazards in `CONTRIBUTING_PARALLEL_SESSIONS.md` §4 describe. The board's lane table is where
  reservations are recorded.
- **Merge conflicts in large code files go to the lane's builder** (mistake M-109, 2026-10-31). The builder resolves
  them with a full workspace build. The master resolves only the migration journal and the ADR index mechanically.
- **Review throughput rises**, because Codex can review Claude lanes in parallel with Claude reviewers, and a
  different-vendor reviewer reduces the shared-blind-spot risk ADR-0191 named.
- **History is kept.** `AgentCoordination.md`, `codexInputs.md` and `geminiInputs.md` stay as records. New findings go
  to the new board's inboxes and to dated files under `internal/reviews/`.

## Addendum (2026-10-31) — Gemini is not used

Later the same day the owner said: "No Gemini, let's only use codex." Decision 2 is withdrawn: Gemini has no role on
the project. Codex alone joins the Claude sessions, as builder and reviewer under decision 1, and also takes the
markdown audits that decision 2 gave Gemini, recorded under `internal/reviews/`. The root `GEMINI.md` pointer is
removed, and the board (`internal/process/AGENT_COORDINATION.md`) lists Claude and Codex only. Everything else in this
ADR stands.
