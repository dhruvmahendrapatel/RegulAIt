# ADR-0006: Token-optimization tooling is a default in every future RegulAIt-built scaffold

- **Status**: Accepted
- **Date**: 2026-07-22

## Context
ADR-0005 adopted `caveman` and `graphify` for this repo specifically. The user separately asked
that this class of tooling be standard for every future tool RegulAIt itself builds (OQ-004,
part b) — not a one-off applied only to RegulAIt's own development.

## Decision
Every scaffold/template RegulAIt generates for a new tool or component (once EPIC-02/EPIC-03
produce a first one to templatize from) defaults to including:
- Output-compression tooling in the spirit of `caveman` (or its then-current equivalent),
  enabled by default, since it's fully local with no exfiltration risk.
- Codebase-context/knowledge-graph tooling in the spirit of `graphify` (or its then-current
  equivalent), **defaulted to code-only/local-parsing mode** — any semantic-extraction mode that
  would send file content to an external LLM must be opt-in per project, never on by default,
  per the same reasoning as ADR-0005.
- Native LLM provider prompt caching wired in by default wherever the platform makes model calls
  on the user's behalf — this is the highest-leverage, lowest-risk token-cost lever identified in
  research and needs no third-party dependency.

Each new tool's scaffold generation step re-runs the same two-part vetting (legitimacy +
independent adoption signal, then a source-level exfiltration check) on whatever the
"then-current equivalent" tools are at the time — this ADR does not pre-approve future,
unvetted replacements for `caveman`/`graphify` by name.

## Consequences
This is a forward-looking policy with no immediate implementation — there is no scaffold
generator yet (EPIC-02/EPIC-03 haven't started). It exists now so the convention isn't
rediscovered or re-argued later. Revisit and supersede this ADR once the first real scaffold
generator is built, if the specifics need to change.
