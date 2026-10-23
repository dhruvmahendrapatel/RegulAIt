# ADR-0198: Freeze-week CI settings: temporary job time caps and the bundle-ceiling allowance

- **Status**: Accepted
- **Date**: 2026-10-23
- **Decision owner**: owner decision 2026-10-23 on #453 (comment 6365927299), on the demo readiness deep scan (#522)

## Context
The code freeze starts 2026-10-29. The internal run-through is Sun 2026-11-01 and the external demo is Tue 2026-11-03
(ADR-0197 set the original plan). The deep scan of main at `4ac353e9` (#522) found two freeze-week risks in CI:

- **Finding 25.** The apt cache key includes the runner image and the browser cache key includes the Playwright version.
  A runner-image roll or a Playwright bump sends every PR to a cold install until main saves the new key.
  `spa-journeys` has a 12.1 min median against its 16-min cap, and a browser-cache miss cancelled it at the cap on
  10-23. Every real-gateway timeout so far was an install step. The mocked UI shards (`mock-ui-shards.yml`) run on the
  same caches with a 15-min cap.
- **Finding 22.** The web entry chunk is at its size-limit ceiling: entry JS 137.28 kB of 137.3 kB and entry CSS
  10.59 kB of 10.6 kB (`apps/web/.size-limit.json`). Any freeze-week fix that touches the shell, the kit, `tokens.css`
  or `global.css` would fail the ADR-0196 size gate.

## Decision
The owner's decisions (2026-10-23, #453), quoted:

> | 25 | CI job time caps | **A temporary, ADR'd raise** of the spa-journeys and mock-shard caps until after 11-03. |

> | 22 | Bundle ceiling | Pre-approved: a blocker fix during the freeze may raise the entry JS/CSS ceiling by up to 1 kB, recorded in the PR and an ADR note. |

### 1. Temporary job time caps (finding 25)
- `ci.yml` `spa-journeys`: `timeout-minutes` 16 → 25.
- `mock-ui-shards.yml` shard job: `timeout-minutes` 15 → 25.
- Each changed line carries the comment "revert after 2026-11-03 (ADR-0198)". The raise covers a cold install only; it
  is not new headroom for slower tests. A run that needs more than the old cap with warm caches is still a finding.
- **Revert** both lines to 16 and 15 in the first CI PR after 2026-11-03.

### 2. Bundle-ceiling allowance during the freeze (finding 22)
- During the freeze (2026-10-29 to 2026-11-03), a **demo-blocking** fix may raise the entry JS and entry CSS ceilings in
  `apps/web/.size-limit.json` by **at most 1 kB in total** (the two raises added together).
- The PR that raises a ceiling records it in its description: the old and new values, the measured sizes and the blocker
  it fixes.
- Every other freeze-week fix stays in lazy chunks and leaves the ceilings unchanged.
- This ADR does not change `.size-limit.json`. Any raise made under this allowance is appended below under "As built".

### 3. Demo journey path filter (finding 21, recorded here for completeness)
The owner's decision on #453 also adds the three missing files to `demo.yml`'s path filter.
`apps/gateway/src/shadow-ai-remediation.ts`, `apps/gateway/src/discovery-*.ts` and `apps/gateway/src/workflows.ts` are
added to both the `pull_request.paths` filter and the `changes` job's diff regex, so edits to them run the Demo journey.
This is a permanent fix, not a freeze-week setting.

## Consequences
- A cold-cache run during freeze week completes instead of being cancelled at the cap, so a runner-image roll does not
  block a demo fix.
- A hung job costs up to 9 (spa-journeys) or 10 (each mock shard) more billed minutes before it is cancelled, until the
  revert.
- A demo-blocking fix in the entry chunk can merge without a separate owner decision, within the 1 kB allowance.
- Follow-up: revert the two caps after 2026-11-03, and reset any ceiling raised under §2 to a value the post-demo build
  supports.

## As built
_(Append here: each ceiling raise under §2, with its PR, and the revert of §1.)_
