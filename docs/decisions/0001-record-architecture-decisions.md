# ADR-0001: Record architecture decisions

- **Status**: Accepted
- **Date**: 2026-07-21

## Context
RegulAIt is a multi-month, multi-session build, worked on conversationally through Claude Code
by a solo, non-engineer-supervised builder. Decisions made in one session are otherwise only
findable by re-reading conversation transcripts, which don't persist across sessions and don't
scale as the project grows.

## Decision
We record every architectural or technical decision as an Architecture Decision Record (ADR) in
`docs/decisions/`, using the format in [ADR-TEMPLATE.md](ADR-TEMPLATE.md), indexed in
[README.md](README.md). ADRs are written the moment a decision is made, not batched to
session-end (see [CLAUDE.md](../../CLAUDE.md) update/commit discipline).

## Consequences
Every future session (this one resumed, or a fresh one) can reconstruct *why* a choice was made,
not just *what* was chosen. Decisions are never edited retroactively — a changed decision means a
new ADR that supersedes the old one, preserving history.
