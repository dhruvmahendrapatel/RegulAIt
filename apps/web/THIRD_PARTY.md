# Third-party runtime dependencies of the web app

Every runtime dependency added to `apps/web` is listed here with its exact version, its licence and why it is
here. Only MIT, Apache-2.0, BSD or ISC licences are accepted. Everything is bundled by the build: nothing is
fetched from a CDN or any other network location at run time, so the UI works air-gapped.

| Package | Version | Licence | Why |
|---|---|---|---|
| `@xyflow/react` | 12.12.0 | MIT | Renders the run graph (ADR-0173 batch 2b): nodes, edges, pan and zoom, keyboard focus. Lazy-loaded with the graph, so it is not in the main bundle. Transitive: `@xyflow/system` (MIT), `zustand` (MIT), `classcat` (MIT), `use-sync-external-store` (MIT), `d3-zoom`, `d3-drag`, `d3-selection`, `d3-transition`, `d3-interpolate`, `d3-color`, `d3-dispatch`, `d3-ease`, `d3-timer` (ISC); `@types/d3-drag`, `@types/d3-interpolate`, `@types/d3-selection`, `@types/d3-transition`, `@types/d3-zoom` (MIT, type declarations only, nothing at run time). Its stylesheet is imported from the package and bundled into the lazy chunk. |
| `@dagrejs/dagre` | 3.1.1 | MIT | Computes the run graph's left-to-right layered layout. Transitive: `@dagrejs/graphlib` (MIT). |
