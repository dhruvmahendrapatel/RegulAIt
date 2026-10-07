# Third-party runtime dependencies of the web app

Every runtime dependency added to `apps/web` is listed here with its exact version, its licence and why it is
here. Only MIT, Apache-2.0, BSD or ISC licences are accepted. Everything is bundled by the build: nothing is
fetched from a CDN or any other network location at run time, so the UI works air-gapped.

| Package | Version | Licence | Why |
|---|---|---|---|
| `react-router-dom`, `react-router` | 7.18.4 | MIT | Existing app routing; the data router and `useBlocker` guard intake links, programmatic navigation and Back/Forward (X13). Bundled locally. Licence verified against installed manifests and npm metadata on 2026-10-06; [upstream](https://github.com/remix-run/react-router). |
| `@xyflow/react` | 12.12.0 | MIT | Renders the run graph (ADR-0173 batch 2b): nodes, edges, pan and zoom, keyboard focus. Lazy-loaded with the graph, so it is not in the main bundle. Transitive: `@xyflow/system` (MIT), `zustand` (MIT), `classcat` (MIT), `use-sync-external-store` (MIT), `d3-zoom`, `d3-drag`, `d3-selection`, `d3-transition`, `d3-interpolate`, `d3-color`, `d3-dispatch`, `d3-ease`, `d3-timer` (ISC); `@types/d3-drag`, `@types/d3-interpolate`, `@types/d3-selection`, `@types/d3-transition`, `@types/d3-zoom` (MIT, type declarations only, nothing at run time). Its stylesheet is imported from the package and bundled into the lazy chunk. |
| `@dagrejs/dagre` | 3.1.1 | MIT | Computes the run graph's left-to-right layered layout. Transitive: `@dagrejs/graphlib` (MIT). |
| `recharts` | 3.10.1 | MIT | Draws the Monitoring page's series charts and dashboard panels (ADR-0173 batch 2c; new dashboards only, the existing hand-written charts are a later replacement item). SVG, keyboard layer off in favour of a data table under every chart, colours from tokens. Transitive: `react-redux` 9.3.0, `redux` 5.0.1, `redux-thunk` 3.1.0, `reselect` 5.2.0, `immer` 11.1.21, `es-toolkit` 1.52.0, `eventemitter3` 5.0.4, `decimal.js-light` 2.5.1, `tiny-invariant` 1.3.3, `clsx` 2.1.1, `use-sync-external-store` (MIT); `victory-vendor` 37.3.6 (MIT AND ISC, vendored d3 modules); `d3-array`, `d3-format`, `d3-path`, `d3-scale`, `d3-shape`, `d3-time`, `d3-time-format`, `internmap` (ISC). |
| `react-is` | 18.3.1 | MIT | recharts' peer dependency, pinned to the app's React 18 line (the auto-installed 19.x would misread React 18 elements). |

## Test-only development dependencies (never shipped)

These run only in the browser test suites (`apps/web/e2e`, Playwright). Nothing in `src/` or the Vite config imports
them, so they are not bundled into the shipped web build (checked: no match for `axe-core` in `apps/web/dist` after
`pnpm --filter @regulait/web build`). A licence outside the allow-list above is accepted here only on that condition.

| Package | Version | Licence | Why |
|---|---|---|---|
| `@axe-core/playwright` | 4.13.0 | MPL-2.0 | Runs automated accessibility checks inside the Playwright specs. Exception: MPL-2.0 is not on the shipped-code allow-list; it is used only in browser test runs and never bundled into the shipped web build. Transitive: `axe-core` 4.13.0 (MPL-2.0, the same exception and the same test-only use). |
