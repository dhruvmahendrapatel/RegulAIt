# Build orchestration: hand-over files

These files describe how the RegulAIt build is run: one master session, builder and reviewer workers, and the merge
loop. They are not product documentation, and nothing here ships. The repo is public, so these files contain no names,
emails, session links or anything else that identifies a person.

| File | What it holds | When it changes |
|---|---|---|
| [AgentHandoff.md](AgentHandoff.md) | Onboarding for a new master, and "Where we left off" | After every batch or decision |
| [DecisionLog.md](DecisionLog.md) | Open questions for the owner at the top, then every owner decision | The moment a decision is given |
| [Status.md](Status.md) | Current state, pending items, done log | After every task |
| [RULES.md](RULES.md) | The orchestration rules (owner, 2026-11-18) | Only on an owner decision |
| `scripts/` | The master's status scan and merge loop | When the process changes |

Mistakes go in [internal/memory/mistakes.md](../../memory/mistakes.md), the existing ledger, not in a second file.
ADRs stay in `internal/decisions/`; product decisions are never logged only here.
