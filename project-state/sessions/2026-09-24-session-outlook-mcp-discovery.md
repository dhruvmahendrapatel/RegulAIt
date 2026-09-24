# Session — 2026-09-24: Outlook approvals, MCP discovery, the posture page, and two defects only a fresh database could find

*Append-only. Never edited retroactively.*

## What was asked

Continuation of the vendor-analysis work. The instruction was **"build the MCP discovery and the
posture UI page"**, following on from the Outlook approvals batch started in the previous chapter.

## What shipped

| Thing | Where |
|---|---|
| MCP-server detection from supplied evidence | `packages/shared/src/mcp-discovery.ts` (9 tests) |
| The registry diff | `POST /v1/shadow-ai/mcp-discovery` (5 tests) |
| Enforcement-posture page | `/admin/enforcement-posture` |
| ADR-0121 (Outlook, send-only) | migration 0112, 7 tests |
| ADR-0122 (MCP discovery) | no migration |
| ADR-0120 correction | migration 0113, +1 test |
| `chatops.test.ts` DDL restore | reads the catalogue, asserts fidelity |

## The three findings worth carrying forward

**1. A capability can ship that no caller can reach, with the suite green throughout.** The Outlook
adapter was complete and unreachable: shared's `connectorProviderKindSchema` — a hand-maintained
mirror of `CONNECTOR_PROVIDER_KINDS` — had never learned the kind, and drizzle's `text({enum})`
widened while the DB CHECK from migration 0069 did not. The type said yes and the storage said no.
Both mirrors are now guarded by a test asserting equality, placed in the gateway because it is the
only package that depends on both — which is precisely why the drift was invisible.

**2. A column's type is a claim about every producer.** ADR-0120 reused `policy_simulation_flips.
policy_id` (uuid) for the kernel's `Decision.ruleId`, which is a uuid only when a stored rule row
matched. Symbolic ids (`default-deny`) raised 22P02 and the simulation returned 500 — on exactly the
traffic the feature exists to serve, because a restrictive-rule preview over real calls is what
produces fall-through decisions. The fixture had one entitled caller, so the differing branch was
never built. Migration 0113; recorded as **M-039**.

**3. Neither defect was reachable from the shared development database, and both looked like flakes.**
Policy simulation replays *every* `mcp_tool` audit row in the window rather than its own fixtures, so
whether it meets a symbolic rule id depends on what else is in the database. And `chatops.test.ts`
dropped a CHECK constraint and restored a hardcoded, now-stale definition — a test mutating shared
DDL and restoring what it remembered rather than what it found, which narrowed the constraint for
every later file and made the Outlook suite pass alone and fail in the full run. Both were
reproduced deliberately before being fixed; the ADR-0120 regression test was confirmed to fail
against the defect reintroduced on purpose, then pass with the fix.

## Verification

Gateway **187 files / 2832 passed / 9 MinIO skips, exit 0, on a FRESH database**, with
`ECONNREFUSED`, `destroySoon`, unhandled and uncaught all at zero. All eleven packages green (1721
tests). Web typecheck and build clean.

One invalid run is worth recording so it is not repeated: `npx vitest run --root .` from the repo
root bypasses `apps/gateway/vitest.config.ts` entirely — it loses `fileParallelism: false`, the
ADR-0106 socket setup file and `REGULAIT_RATE_LIMIT: off`, and sweeps in Playwright specs. It
produced 53 failed files and none of it meant anything. **The command is `pnpm -r test`.**

## Still open

- **S8** — the undiagnosed intermittent in `compat-longtail.test.ts`, unchanged.
- **MCP discovery has no UI and writes no finding**, so an unregistered host does not yet flow into
  ADR-0055's "pull into governance" workflow.
- **The Outlook courier has no UI** — registering one is an API call.
- **Actionable Messages** remains the only route to a verifiable decide-from-inbox, and needs a
  per-tenant originator id this repository cannot hold.
- **The mirror-drift guard covers connector kinds only.** `CHATOPS_PROVIDERS`, the model-provider
  kinds and the PM-adapter kinds are the same shape of hand-maintained list and deserve the same
  sweep rather than waiting for the next silent one.
- Monday demo prep: a deterministic seeded-and-hardened environment, and a rehearsal of the four PoC
  criteria.
