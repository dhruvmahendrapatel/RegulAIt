# Session log — 2026-08-15, the feature-review wave closes

Immutable, append-only. Written at the close of the ten-slice adversarial
feature review begun 2026-08-13.

## What this chapter did

- **Slices 1–4** (earlier in the wave): inert server grant refused; anchoring
  default-on; the semantic-cache PII bypass; two ADR-0022 separation-of-duties
  holes (delegation self-review, deploy-override self-attestation); local WORM
  anchoring via MinIO Object Lock (COMPLIANCE, observed grading); pillar-7
  inheritance attacked and held; the deployment-wide PII floor (owner call).
- **Slices 5–10** (this session, delegated to probe agents, independently
  re-verified on fresh DBs before every push): one real defect found and fixed
  — a refused dispatch left phantom pillar-6 savings rows (`79d65e5`); the
  ADR-0042 floor pinned at the dispatch seam; MRM proven at the orchestration
  and IDE-interception seams; the PM webhook proven unable to start instances;
  the update-bundle verifier attacked with real Ed25519 keys (no prior test);
  the installer key gate driven live; a real git kind driven through the
  workflow executor for the first time; the PM mirror-failure path proven not
  to unwind governance.
- **UI**: deploy-override reason contract, self-review copy, PII-floor
  relabel, and the ADR-0060 chain-integrity card — each proven in a real
  browser (Playwright, fresh seeded gateway per run).
- **mistakes.md** shipped (owner mandate) — 14 entries, bootstrap-wired.
- **Market analysis 2026-08-15** (`docs/product/MARKET_ANALYSIS_2026-08.md`):
  compliance cascade = most defensible claim; P5 wedge real but on a clock;
  P6 not pillar-scale; P8 window closing fastest.

## Numbers

Gateway suite 1997 → **2064 passed / 122 files** (+9 MinIO real-server skips,
proven live once). Playwright 101 → 104. Zero failures at close. GitHub
Actions exhausted mid-wave — owner directive: internal validation only.

## Open decisions for the owner (all recorded in STATE.md)

Savings-semantics ×2 (cache-hit on blocked project; decision-only routing
rows); session-narrowing issuance scope; mirror-failure persistence; PII floor
default stays `none` (one PUT flips it); deploy-override second approver.

## Next build queue (from the market analysis, filtered by standing constraints)

The top two items (live provider, live-instrument verification) are blocked on
credentials the owner keeps parked. Buildable now, in order: **(3)** scheduled
cost reconciliation + roster adapter for the P5 wedge, **(4)** the compliance
cascade as the demo, **(7)** workflow-template gallery mapped to the cascade,
**(6)** tighten-only-delegation conformance suite.

## Addendum — the post-review build wave (same day)

With the review closed, three market-queue items shipped, each verified by the
dispatching session on its own fresh database before push:

- **ADR-0076** (migration 0085) — scheduled cost reconciliation + roster ingest.
  The ADR-0069 double-count was REPRODUCED first (66.66 through the real API),
  then closed to 33.33 with every line still present; supersession is marked,
  disclosed in the read, audited, and reversible (revoke reinstates). Roster
  ingest feeds the existing alias/cost-centre write paths and refuses ambiguity
  by name rather than guessing.
- **ADR-0077** — the compliance cascade becomes the demo's headline (a HIPAA
  instance parked at a stage no rule routed, a live PII refusal, a floored
  retention) and a template gallery whose cascade annotations are DERIVED from
  the enforcement rules; proven by flipping a profile and watching the
  annotations move, and by an injected stale-cache defect turning 6/9 red.
- **ADR-0078** — the tighten-only delegation invariant as an enumerated
  conformance contract (dimensions × levels, n/a cells declared not omitted)
  plus an honest MCP/A2A interop note: the guarantee is about our choke point
  and does not survive a remote agent's own sub-delegation.

Recovered one agent's complete-but-uncommitted work after a model-limit kill
(M-015). Final: **2108 passing / 126 files**, zero failures.
