# ADR-0146: Native Semantic-Cache Request and Configuration Identity

Status: Accepted (implemented)
Date: 2026-10-01
Finding: AER-041
Related: ADR-0119 (shared cache boundary), ADR-0136 (exact compat identity),
ADR-0138 (governed cache hits), ADR-0048/0073 (prompt and agent_config versions)
Migration: none

## Context

The native `/v1/agents/:id/invoke` cache keyed on `body.input` trimmed,
lower-cased and whitespace-collapsed, scoped by user and agent. ADR-0138 made a
hit pass the live governance gates, but the gates judge the configuration that
serves *now* while the cached bytes may come from a different request or an
older configuration. Concretely: case-sensitive identifiers collided, a
`maxTokens: 50` request could receive a prior long answer, the caller's
`system`, `baseline`, reference content and attachments were ignored, and
changing the agent's model, system prompt or active version invalidated
nothing. The existing test suite pinned the case/whitespace hit as intended
behaviour.

## Decision

The native key is a SHA-512 commitment (prefix `native-v2:`) to two objects,
built from verbatim values with nothing normalised away:

1. **Request** — `input`, `mode`, `system`, `baseline`, `referenceContent`,
   `attachments` (kind, name, media type, bytes), `maxTokens`,
   `costSensitivity`, the attributed `projectId`, and the planner dials that
   rewrite the outgoing input (file-preprocessing and edit-vs-rewrite mode and
   thresholds). Delivery/bookkeeping fields (`stream`, `semanticCache`,
   `dispatch`, `instanceId`) are excluded: they cannot change the answer.
   Conversations remain excluded from the cache entirely.
2. **Configuration** — re-read at lookup: agent id, provider, model, custom
   provider id/wire protocol/base URL, the `systemPrompt` column, the active
   `agent_config` version, and the prompt version this user's stable key
   resolves to, including the canary flag. Changing any of these makes old rows
   miss; re-activating the identical immutable version makes them valid again,
   because that configuration is once more the one that serves.

Store-side rules:

- Store only when the **requested agent served** the answer and no fallback hop
  did. A routed or fallback answer was produced under a different
  configuration; filing it under the requested agent's key would misdescribe
  it, and a later hit's governance would judge the wrong agent.
- Re-read the configuration **after** dispatch and store only if the key is
  unchanged, so a mid-flight model/prompt/version change cannot file an
  old-configuration answer under the new key.

Only the commitment is stored (`normalizedInput` holds `native-v2:<sha512>`),
never request plaintext. The existing SHA-256 index plus full-commitment
comparison remains the collision guard. Pre-ADR rows hold normalised plain
text, can never equal a `native-v2:` commitment, and therefore miss closed and
age out through the TTL; no data migration is required.

## Consequences

- Case, whitespace and option variants now miss. This lowers hit rate by
  design: the old hits were the defect.
- **Routing reduces cacheability.** The key is computed before routing, so it
  commits to the requested agent. When routing serves another agent, nothing
  is cached for that request. The router also moves calls *sideways* on an
  exact cost-and-tier tie (smaller id wins, zero savings), so a roster of
  identically priced peers can make an agent's calls uncacheable. Both are
  observed, not hypothetical (this ADR's own test fixture first failed that
  way). Follow-ups, not done here: key on the served configuration by moving
  lookup after routing, or persist served identity (needs a migration); and
  separately decide whether a zero-saving sideways route should happen at all.
- The cache now costs two extra configuration reads per opted-in dispatch
  (lookup and post-dispatch check): indexed single-row reads plus the version
  tables.

## Verification

`apps/gateway/src/zz-aer041-native-cache-identity.test.ts` (6 tests) on a fresh
database, each test with its own user so routing rosters cannot leak between
tests:

- Byte-identical re-ask hits with zero usage delta (positive control); case,
  whitespace, `maxTokens` (changed and removed), caller `system`, `baseline`,
  reference content, cost sensitivity and project attribution each miss with
  exactly one real dispatch; the original remains cached afterwards.
- A system-prompt version change misses; re-activating version 1 hits again;
  a model change misses.
- A downrouted answer is not stored under the requested agent; the test first
  asserts that routing actually moved the call.
- Field-omission control: every request/config field has a mutation that must
  change the key, and the mutation table is checked against the objects' own
  keys, so a new field without coverage fails.
- Collision control: a row matching the index hash but not the commitment is
  refused, and a legacy-shaped row misses.
- The row stores no request plaintext.

`semantic-cache.test.ts` case (a) previously sent a case/whitespace variant and
expected a hit; it now re-asks byte-identically. The prior passing assertion is
itself the evidence that the new miss matrix detects the old behaviour.

Not exercised: a barrier that changes configuration *during* a dispatch (the
post-dispatch re-check is covered only by the same key comparison the miss
tests use); provider/custom-endpoint changes through the API (provider is not
editable — rebinding is a new agent — and is covered by the unit control);
canary-split assignment through a live canary rollout (covered by the unit
control on the canary flag).
