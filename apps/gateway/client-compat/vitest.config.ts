import { defineConfig } from "vitest/config";

// ADR-0257 — the third-party client compatibility harness. Kept OUT of the gateway
// suite (`vitest run --dir src`): it needs docker and the prebuilt client images,
// and runs in its own CI job (.github/workflows/client-compat.yml).
export default defineConfig({
  test: {
    include: ["client-compat/**/*.test.ts"],
    fileParallelism: false,
    // The same setup the gateway suite uses (see ../vitest.config.ts for why).
    setupFiles: ["./src/testing/mock-socket-contract.ts", "./src/testing/receipt-signing-key.ts"],
    // Each client container boots its runtime and makes a dozen real HTTP calls.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    env: {
      // One harness drives every client from one address; the limiter is not under test.
      REGULAIT_RATE_LIMIT: "off",
      REGULAIT_SCHEDULER: "off",
      // the in-process upstream MCP server is admitted without a network probe
      REGULAIT_OFFLINE_CHECKS: "1",
    },
  },
});
