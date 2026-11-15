import { defineConfig } from "vitest/config";

// ADR-0326 — the live pilot-path harness. Kept OUT of the gateway suite (`vitest run --dir src`): it calls real
// vendor APIs with test credentials and runs only in `.github/workflows/live-tests.yml` (manual dispatch and nightly,
// in the `live-tests` environment). Every group skips itself when its credentials are absent, so a run with none
// set is green and calls nothing.
export default defineConfig({
  test: {
    include: ["live/**/*.live.test.ts"],
    fileParallelism: false,
    setupFiles: ["./src/testing/mock-socket-contract.ts", "./src/testing/receipt-signing-key.ts", "./src/testing/bootstrap-grant-mint.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      REGULAIT_RATE_LIMIT: "off",
      REGULAIT_SCHEDULER: "off",
    },
  },
});
