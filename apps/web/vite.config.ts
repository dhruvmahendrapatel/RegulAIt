import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The routing library's package exports name only its development build (dist/development, with its dev warnings
// switched on), under every condition. It ships the production build beside it (dist/production, the same code with
// the warnings switched off), so `vite build` resolves the same entries and swaps the folder. The dev server, unit
// tests and the mocked suite keep the development build and its warnings. If an upgrade moves the files, the build
// fails here instead of silently shipping the development build again (guard: scripts/preflight-ui-prod-bundle.mjs
// and scripts/preflight-ui-prod-bundle.test.mjs).
const routerProductionBuild: Plugin = {
  name: "routing-library-production-build",
  apply: "build",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (source !== "react-router" && source !== "react-router/dom") return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!resolved) return null;
    const id = resolved.id.replace(/([\\/]dist[\\/])development([\\/])/, "$1production$2");
    if (id === resolved.id) this.error(`${source} resolved to ${resolved.id}, which is not under dist/development`);
    return { ...resolved, id };
  },
};

// The SPA is served by the gateway at /ui (apps/gateway/src/web-serving.ts):
// `base` makes every built asset URL /ui/-relative, so index.html works both
// from the gateway and from `vite preview`. The dev server proxies the API to
// a locally running gateway so cookies stay same-origin.
export default defineConfig({
  plugins: [react(), routerProductionBuild],
  base: "/ui/",
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // the polyfill only emulates <link rel="modulepreload"> on browsers without native support (older Firefox and
    // Safari, which the default target still includes). Those still load every lazy chunk correctly, just without
    // fetching its imports ahead; dropping it saves about 0.6 kB of the all-JS budget
    modulePreload: { polyfill: false },
    // ADR-0196 U4: the vendored logos (src/ui/logos/svg) stay files under /ui/assets instead of data: URIs inside
    // the JS, so a screen fetches only the marks it draws, as cacheable images, and parses no logo bytes as script
    assetsInlineLimit: (file) => (file.endsWith(".svg") ? false : undefined),
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/admin": "http://localhost:3000",
      "/app": "http://localhost:3000",
    },
  },
});
