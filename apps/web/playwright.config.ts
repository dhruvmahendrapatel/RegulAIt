import { defineConfig } from "@playwright/test";

/**
 * Web e2e: a REAL gateway (built dist, seeded demo dataset, its own scratch
 * database) serving the REAL built SPA at /ui. global-setup boots and seeds;
 * the tests sign in as a seeded persona with the printed one-time password.
 *
 * Requires: PLAYWRIGHT_BROWSERS_PATH pointing at a provisioned browsers dir
 * (CI/dev boxes here use /opt/pw-browsers — never `playwright install`).
 */
export default defineConfig({
  testDir: "./e2e",
  // CI-02: the two demo journeys have their own configs (demo-real: a
  // gateway YOU started on a demo:prepare database; demo-mock: a Vite server
  // on :4179) and each selects its spec by testMatch. Collected here they fail
  // on an unrelated precondition (no shadow-AI findings in the seed, no Vite
  // server), which made the documented `pnpm e2e` unable to pass.
  testIgnore: ["**/demo-*.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3105",
    browserName: "chromium",
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
      : undefined,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
});
