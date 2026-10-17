import { defineConfig, devices } from "@playwright/test";

/**
 * The enterprise UI harness (ADR-0196): accessibility, keyboard, responsive, state consistency, table density,
 * performance budgets and the screenshot pack, over every screen in the SPA route census
 * (scripts/ui-spa-routes.mjs), against the mocked API (e2e/enterprise/mock-api.ts).
 *
 * It runs the BUILT app (`vite build`, then `vite preview`), because the performance budgets mean nothing on the
 * dev server and the other checks should see what ships. No gateway, database or seed.
 *
 * Projects:
 *   chromium              every check (axe, keyboard, responsive, states, density, performance)
 *   firefox, webkit       the cross-browser checks: keyboard journeys and the responsive pass
 *   screenshots           the screenshot pack (route x viewport x theme); only run on request (its own CI job)
 *
 * Browsers: Chromium comes from PLAYWRIGHT_BROWSERS_PATH here (never `playwright install` on a dev box); CI
 * installs all three with the pinned Playwright version.
 */
const PORT = 4180;
const DESKTOP = { width: 1440, height: 900 };
const CROSS_BROWSER = /enterprise\/(keyboard|responsive)\.ent\.spec\.ts$/;
const chromiumLaunch = process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined;

export default defineConfig({
  testDir: "./e2e/enterprise",
  testMatch: /\.ent\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: DESKTOP,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /screenshots\.ent\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP, launchOptions: chromiumLaunch },
    },
    { name: "firefox", testMatch: CROSS_BROWSER, use: { ...devices["Desktop Firefox"], viewport: DESKTOP } },
    { name: "webkit", testMatch: CROSS_BROWSER, use: { ...devices["Desktop Safari"], viewport: DESKTOP } },
    {
      name: "screenshots",
      testMatch: /screenshots\.ent\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP, launchOptions: chromiumLaunch },
    },
  ],
  webServer: {
    command: `npx --no-install vite build --logLevel warn && npx --no-install vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/ui/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
