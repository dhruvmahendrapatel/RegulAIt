import { defineConfig } from "@playwright/test";
import { CREDENTIAL_SAFE_ARTIFACTS } from "./playwright.credential-safe";

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
  // The enterprise UI harness (e2e/enterprise, ADR-0196) has its own config and server too.
  testIgnore: ["**/demo-*.spec.ts", "**/*.mock.spec.ts", "**/enterprise/**"],
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
    // e2e only: reduced motion, under which global.css removes every transition and animation,
    // so an axe check right after a theme switch never reads a colour mid-way through a 120 ms transition (N9)
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
      : undefined,
    viewport: { width: 1400, height: 900 },
    // no trace, no video: a trace keeps every typed password (playwright.credential-safe.ts)
    ...CREDENTIAL_SAFE_ARTIFACTS,
  },
});
