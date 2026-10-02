import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The SPA is served by the gateway at /ui (apps/gateway/src/web-serving.ts):
// `base` makes every built asset URL /ui/-relative, so index.html works both
// from the gateway and from `vite preview`. The dev server proxies the API to
// a locally running gateway so cookies stay same-origin.
export default defineConfig({
  plugins: [react()],
  base: "/ui/",
  resolve: {
    alias: {
      // The package root also exports server-only hashing helpers. Keep the
      // browser boundary on the reviewed, data-only module while callers use
      // the public package name required by the coordination contract.
      "@regulait/shared": fileURLToPath(new URL("../../packages/shared/src/demo-intake/scenario-library.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
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
