# Session — 2026-08-20: the competitive queue built end to end

Immutable session record (append-only convention; never edited retroactively).

## What landed, in order

1. **L3 — SOC 2 pack** (`d65daab`): seventh seed compliance pack, Security/Common
   Criteria only, 10 controls (3 enforced / 3 evidenced / 1 partial / 3 attestation-
   required), no CPA review claimed, `cascadeTag` null. Dated amendment on ADR-0058.
2. **L1 — AI use-case registry + intake front-door** (ADR-0080, migration 0086):
   a governance object whose `complianceTags` are the cascade's own tags; status
   changes only through the pillar-2 intake instance's decision; both lifecycle
   joins proven non-vacuous. Suite 2136+9/128, Playwright 107.
3. **L2 — AI risk register** (ADR-0081, migration 0087): eight-entry
   `DEFAULT_RISK_LIBRARY`; evidence computed at read time through a fixed
   category→resolver mapping over the real ledgers; measured vs declared never
   blended; audited terminal acceptance freezes the evidence it was taken on.
   Suite 2152+9/129.
4. **L7+L8 — dependency inventory + posture one-pager** (ADR-0082, no migration):
   granted (may) vs observed (did) never blended; every posture number a SELECT at
   request time; empty renders *unmeasured, not resisted*. Suite 2172+9/131,
   Playwright 109.
5. **L4 — first-party shadow-AI discovery** (ADR-0083): frozen hash-pinned
   81-entry catalogue; classifier over operator-supplied logs/manifests through
   ADR-0071's ingest path; governed-via-gateway vs shadow computed from live
   credential config, deliberately not the egress allow-list. Suite 2183+9/132,
   Playwright 110.
6. **L5 — vendor AI-risk portal** (ADR-0084, migration 0088): vendors on the
   pillar-2 assessment rails; vendor answers are attributed attestations pinned
   never to become evidence; SOC 2 v1 left byte-identical, CC9.2 graduation path
   recorded; risk register gains `third_party_ai` with a real resolver.
   Suite 2200+9/133, Playwright 111.
7. **Four-vendor gap analysis** (owner-directed): Holistic AI, watsonx.governance,
   Fiddler, OneTrust → `docs/product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md`,
   lacks L9–L19 ranked, ten near-miss claims struck after in-repo verification;
   all four vendor sites egress-blocked, per-source honesty grades recorded.
8. **L10 — EU-AI-Act tier screening** (ADR-0085, migration 0089): frozen 17-rule
   data-only ruleset, server-side-only computation, tier informs the sign-off and
   never auto-blocks; e2e auth rate-limit fixture cliff found and fixed.
   Suite 2208+9/134, Playwright 112.
9. **L12 — model-card autofill** (ADR-0086, no migration): the card as a window
   you sign — read-time ledger sections, sign-off snapshot into audit detail,
   staleness counted since last certification; no fairness number synthesized.
   Suite 2218+9/135, Playwright 113.

Every slice: built by a dispatched agent on its own scratch DB, verified by the
agent, then independently re-verified here on a fresh `regulait_test` before the
next dispatch. GitHub Actions exhausted throughout — local suites were the only
gate. All pushed to `claude/status-check-2gbrwf` (draft PR #108).

## Process ledger

- **M-019 logged (REPEAT of M-014)**: the L4 agent parked on a watcher despite
  the rule in its brief; rule rewritten to make parking impossible (foreground
  suite runs with explicit timeouts, stated inside the verification step). All
  later briefs carry it; no recurrence in L5/L10/L12.
- Stop-hook WIP checkpoints became standard: `git add -A` checkpoint pushed
  mid-agent, agent soft-resets to its base before structuring scoped commits
  (worked cleanly for L1, L4, L5; L10/L12 briefs pre-warn).

## Owner directives recorded this session

- Build L4 and L5 after L7/L8 (overriding the gap doc's defer notes).
- L6 dispatches the moment the model credential is unparked (do not ask for it).
- Validate against Holistic AI / watsonx.governance / Fiddler / OneTrust without
  stopping build progress — done in parallel, tasks queued from its dispositions.

## Open at session close

- L13 (assessment AI pre-fill) — owner decision: collides with ADR-0080's
  "the answers are yours".
- L14 external-scorer adapter, L15 pack-version diff — buildable "later" items,
  next up under the standing keep-building goal.
- L9 LLM-half bias/fairness (instrument-gated), L11 live-traffic drift
  (instrument-gated), L17/L18 deliberate refusals, L19 certification spend
  (owner call).
- Prior open owner decisions stand (model credential, pillar-6 savings
  semantics, PII floor default, session-narrowing scope, mirror-failure
  persistence).
