# Third-party runtime dependencies of the web app

Every runtime dependency added to `apps/web` is listed here with its exact version, its licence and why it is
here. Only MIT, Apache-2.0, BSD or ISC licences are accepted. Everything is bundled by the build: nothing is
fetched from a CDN or any other network location at run time, so the UI works air-gapped.

| Package | Version | Licence | Why |
|---|---|---|---|
| `@xyflow/react` | 12.12.0 | MIT | Renders the run graph (ADR-0173 batch 2b): nodes, edges, pan and zoom, keyboard focus. Lazy-loaded with the graph, so it is not in the main bundle. Transitive: `@xyflow/system` (MIT), `zustand` (MIT), `classcat` (MIT), `use-sync-external-store` (MIT), `d3-zoom`, `d3-drag`, `d3-selection`, `d3-transition`, `d3-interpolate`, `d3-color`, `d3-dispatch`, `d3-ease`, `d3-timer` (ISC); `@types/d3-drag`, `@types/d3-interpolate`, `@types/d3-selection`, `@types/d3-transition`, `@types/d3-zoom` (MIT, type declarations only, nothing at run time). Its stylesheet is imported from the package and bundled into the lazy chunk. |
| `@dagrejs/dagre` | 3.1.1 | MIT | Computes the run graph's left-to-right layered layout. Transitive: `@dagrejs/graphlib` (MIT). |
| `recharts` | 3.10.1 | MIT | Draws the Monitoring page's series charts and dashboard panels (ADR-0173 batch 2c; new dashboards only, the existing hand-written charts are a later replacement item). SVG, keyboard layer off in favour of a data table under every chart, colours from tokens. Transitive: `react-redux` 9.3.0, `redux` 5.0.1, `redux-thunk` 3.1.0, `reselect` 5.2.0, `immer` 11.1.21, `es-toolkit` 1.52.0, `eventemitter3` 5.0.4, `decimal.js-light` 2.5.1, `tiny-invariant` 1.3.3, `clsx` 2.1.1, `use-sync-external-store` (MIT); `victory-vendor` 37.3.6 (MIT AND ISC, vendored d3 modules); `d3-array`, `d3-format`, `d3-path`, `d3-scale`, `d3-shape`, `d3-time`, `d3-time-format`, `internmap` (ISC). |
| `react-is` | 18.3.1 | MIT | recharts' peer dependency, pinned to the app's React 18 line (the auto-installed 19.x would misread React 18 elements). |
| `@simplewebauthn/browser` | 14.0.0 | MIT | The browser half of passkeys (ADR-0186 A/B): `startRegistration` / `startAuthentication` wrap `navigator.credentials.create/get` with the base64url encoding the server library expects, instead of hand-written ArrayBuffer conversion. Released 2026-09-02. No dependencies; bundled by the build, no CDN, works air-gapped. Added by the batch-4 foundation; the screens that use it are slices A/B and Codex's. |
