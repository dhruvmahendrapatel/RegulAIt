# ADR-0344: Per-route bundle budgets in place of one all-JS total

- **Status**: Accepted (owner decision of 2026-11-16, relayed by the master session to lane UI-C). Applied in two
  steps: this ADR's PR adds the per-chunk ceilings and their coverage check; removing the `all JS` total also needs a
  change to the ceiling guard, which the owner lands (see "What is not done here"). Amended 2026-11-21: the JS gate counts first-load JS only, and `all JS` is removed (see the addendum).
- **Date**: 2026-11-16
- **Index**: Per-route bundle budgets: one gzip ceiling per JS chunk in place of the single all-JS total; the entry budget stays strict
- **Builds on**: [ADR-0196](0196-ui-enterprise-harness.md) (the bundle ceilings and their guard), [ADR-0200](0200-engineering-best-practice-guidelines.md) (front-end guidelines: lazy loading, minified bundles)
- **Migration**: none

## Context

`apps/web/.size-limit.json` had five ceilings: the entry JS and entry CSS (the first-load budget), two heavy lazy
chunks, and `all JS`, the gzip sum of every JS file under `dist/assets` (1,150 kB). Every new screen had to fit under
that one shared total, however rarely it loads.

On 2026-11-16, `all JS` on main was 1,149,603 B, 397 B under the ceiling. Four UI-C screens (#823, #829, #831, #837),
each lazy-loaded in its own admin route chunk, added 1.7 to 3.7 kB each and failed. Moving a screen into a different
lazy chunk does not lower a sum over all chunks. So unrelated screens blocked each other, and each needed an owner
raise of the shared total. Fifteen such raises are recorded in `CEILING_EXCEPTIONS` since 2026-10-21.

ADR-0200's front-end guidelines already ask for lazy loading (routes, heavy components) and minified bundles. The
total measured something else: it grew with every lazily loaded screen, even though a user loads only the routes they
open.

## Decision

1. **The first-load budget stays strict and unchanged.** `entry JS (index)` (139.5 kB) and `entry CSS (index)`
   (10.7 kB) keep their limits and their guard: a raise still needs an owner exception under ADR-0196.
2. **Every other JS chunk has its own gzip ceiling**, named `chunk: <name>` with the path
   `dist/assets/<name>-????????.js`. `<name>` is the chunk name Vite writes (`assets/[name]-[hash].js`): for a route
   group, the `src/screens/<group>` barrel that `App.tsx` lazy-loads; for a shared chunk, the module it is named after.
   The two older lazy ceilings (`lazy: SeriesLineChart`, `lazy: RunGraphCanvas`) stay as they are.
3. **Headroom**: a new chunk ceiling is the chunk's gzip size plus 10%, and at least 2 kB more, rounded up to the next
   0.1 kB (`HEADROOM` in `scripts/ui-chunk-budgets.mjs`). The 2 kB floor keeps a small chunk from failing over a few
   hundred bytes; the 10% leaves room for a screen or two in a route. Measured on 2026-11-16, the two UI-C screens in
   `admin-integrations` (#823 +3.7 kB, #837 +2.7 kB) together fit that chunk's 93.8 kB ceiling.
4. **Raising a chunk ceiling** works the same way as raising any ceiling today: one `CEILING_EXCEPTIONS` row and an
   owner decision recorded in ADR-0196.
5. **A route that is not lazy-loaded counts against the entry budget.** Anything `App.tsx` imports statically is
   bundled into the entry chunk, so it is measured by `entry JS (index)`.
6. **Coverage check.** `node scripts/ui-chunk-budgets.mjs --check` runs after the build in the
   `ui enterprise / tokens, baseline guard, bundle size` job. It fails when:
   - an emitted JS chunk has no ceiling, so a new lazy route cannot land without one;
   - a chunk is covered by two ceilings;
   - two chunks share a name, which size-limit would add up under one ceiling;
   - a `chunk:` ceiling names a chunk the build no longer emits.

   `--write` adds the missing ceilings at size plus headroom and drops stale ones. It never changes an existing limit.

### Open-source options considered (ADR-0176)

Searched in the repo and on npm on 2026-11-17. The repo already runs size-limit, and the ADR-0196 baseline guard protects
its ceilings. Every option below is MIT-licensed.

| Option | Release | Fit |
|---|---|---|
| **size-limit** 14.3.0 (in use) | 2026-10-22 | Supports per-entry ceilings, so it measures each `chunk:` entry. It sums every file a path matches and does not report a file that no entry covers. |
| bundlewatch 1.2.0 | 2026-11-05 | Applies a glob's `maxSize` to each file it matches: one size for every chunk, not one per route. Its baselines and PR statuses use bundlewatch.io and a GitHub token, which do not work air-gapped. It does not report an uncovered file. |
| bundlesize 0.18.2 | 2024-03-15 | Has had no release in more than 12 months, so it fails the ADR-0176 maintenance rule. bundlewatch is its successor. |
| vite-plugin-bundlesize 0.3.0 | 2025-08-29 | Applies the first matching glob's limit to each chunk. A catch-all `**/*` gives every unlisted chunk one shared size, so a new chunk is never refused. It would be a second source of ceilings beside size-limit, which the ADR-0196 guard refuses. |
| Vite `build.chunkSizeWarningLimit` | n/a | One uncompressed warning size for every chunk. It never fails the build. |
| rollup-plugin-visualizer 7.1.3 | 2026-11-08 | Draws the bundle. It enforces nothing. |

None of them fails when an emitted chunk has no ceiling of its own, and that check is the core of this decision. So we
keep size-limit for measuring and enforcing, which reuses the existing guard and `CEILING_EXCEPTIONS`. Under ADR-0176
rule 4, the only code we write is the coverage check and the `--write` helper in `scripts/ui-chunk-budgets.mjs`. They
use only Node built-ins, and `--write` measures with the same gzip level 9 that size-limit uses.

### What is not done here

The removal of `all JS` (the `all JS` ceiling is removed once the owner lands the guard change) needs one change in
`scripts/ui-enterprise-baseline.mjs`. Its `--guard` refuses a removed `.size-limit.json` entry, and that guard protects
the ceilings, so a lane does not edit it.

The intended change is for the guard to allow two kinds of removal:
- a `chunk:` ceiling, because the coverage check fails while that chunk is still built;
- an entry named by a dated row that cites this ADR.

Until then `all JS` stays at 1,150 kB alongside the per-chunk ceilings. The coverage check treats it as a total, not a
chunk's ceiling.

## Consequences

- A screen that grows only its own route chunk no longer blocks a screen in another route. A route that outgrows its
  headroom needs one owner raise, for that route only.
- The ceilings file grows from 5 entries to about 100. `--write` maintains them, and the coverage check keeps them
  complete.
- Shared chunks have ceilings too. A shared module that grows is caught in its own chunk, not hidden in a total.
- Renaming a route chunk replaces its ceiling with a fresh one at the new size plus headroom, so a reviewer of such a
  rename sees the `.size-limit.json` diff.
- size-limit measures every ceiling with its own gzip (level 9). `--write` measures the same way, so a fresh ceiling
  starts exactly 10% (or 2 kB) above what CI reads.

## Addendum (2026-11-21): the JS gate counts first-load JS only

Recorded from an owner decision of 2026-11-21, relayed to lane UI-C by the master session. The decision text is
"owner decision 2026-11-21: the JS bundle gate counts first-load JS only". This addendum lands the step that "What is
not done here" left open.

- **Hard budgets: first-load JS and first-paint JS.** Two totals bound what a first visit loads. Both are read from
  Vite's build manifest, and raising either limit needs a `CEILING_EXCEPTIONS` row and an owner decision.
  - `first-load JS` is the entry chunk plus every chunk it imports statically. Its limit is 139.5 kB, the same as
    `entry JS (index)`, which was set when the whole first load was one file. On 2026-11-21 it is 8 chunks,
    134,006 B.
  - `first-paint JS` adds the screen each first-visit path renders: `/login` (the sign-in screen) and `/` (home after
    sign-in), as App.tsx's routes declare. It also adds every chunk those reach through static or dynamic imports. The
    only thing left out is the entry's route table, its dynamic imports of the other screens App.tsx declares. Any
    other dynamic import counts, whether the code awaits it at once or later. So moving code out of the entry or a
    first screen into a new lazy chunk does not take it out of the total. That closes the gap the R3 review of #1185
    found: the first screens are themselves lazy, and `first-load JS` alone did not count them. On 2026-11-21 it is
    24 chunks, 177,320 B. Its limit is 182 kB, which leaves about the same room (4.7 kB) as `first-load JS` (5.5 kB).
  - `entry JS (index)` and `entry CSS (index)` stay as they are.
- **Lazy chunks: their own, looser cap.** Each lazily loaded chunk keeps its `chunk:` ceiling (gzip size plus 10%, at
  least 2 kB more). None of them counts toward a shared total.
- **`all JS` is removed.** owner decision 2026-11-21: the JS bundle gate counts first-load JS only, so `all JS` leaves `apps/web/.size-limit.json`.
- **Guard (`scripts/ui-enterprise-baseline.mjs --guard`).** It still refuses every raised limit and every changed
  option, with three exceptions:
  - It allows removing an entry named by a dated `CEILING_REMOVALS` row whose decision a line of this ADR names
    together with the entry. That row is `all JS`.
  - It allows removing a `chunk:` ceiling, because the coverage check fails while that chunk is still built.
  - It allows the two totals to change their path lists, but only to exact chunk paths that include the entry chunk.
    Their limits and other options stay guarded.
- **Coverage check (`scripts/ui-chunk-budgets.mjs --check`).** It reads `dist/.vite/manifest.json`, so the CI bundle
  job builds with `--manifest`, and only that job's checks read the file. It fails when either total is missing, does
  not measure gzip, or does not list exactly the chunks it adds up. It also fails closed when App.tsx renders no lazily
  loaded screen at a first-visit path. `--write` sets both path lists from the build and never changes a limit.
- **Open-source options (ADR-0176).** size-limit still does the measuring. The import graph comes from Vite's own
  `build.manifest` (`--manifest`), not from parsing `index.html` or the bundle. Loading `/` and `/login` in the
  Playwright harness and recording script requests would also work, but it would need a browser in the bundle job,
  and it would see only what one run happens to fetch. No library on npm checks that a ceiling covers exactly a first
  visit's chunks (see the table above).
