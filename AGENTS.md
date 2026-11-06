# Instructions for coding agents (Codex and others)

This repository's rules live in [CLAUDE.md](CLAUDE.md). They bind every agent, not only Claude: the suite rules, the
production guardrail, secure by default, open source first, the engineering guidelines and the security checklist.

Before you act:

1. Read [CLAUDE.md](CLAUDE.md), then [internal/memory/STATE.md](internal/memory/STATE.md) and
   [internal/memory/mistakes.md](internal/memory/mistakes.md).
2. Read the live board, [internal/process/AGENT_COORDINATION.md](internal/process/AGENT_COORDINATION.md), and check in
   there. It says what your role is (ADR-0227), which lane is yours, which migration and ADR numbers are reserved, and
   what you must never do.
3. Work only on a lane the Claude master has assigned to you on that board. Never merge, mark a PR ready, pick a
   migration or ADR number, or edit `internal/memory/STATE.md` or the ADR index.
