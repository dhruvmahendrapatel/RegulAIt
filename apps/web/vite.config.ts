import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the gateway at /ui (apps/gateway/src/web-serving.ts):
// `base` makes every built asset URL /ui/-relative, so index.html works both
// from the gateway and from `vite preview`. The dev server proxies the API to
// a locally running gateway so cookies stay same-origin.
export default defineConfig({
  plugins: [react()],
  base: "/ui/",
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // every browser the build targets loads lazy chunks the same without it: the polyfill only prefetches
    // <link rel="modulepreload"> on the few that lack it natively, and costs about 0.6 kB of the all-JS budget
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
