import { defineConfig } from "@playwright/test";
import { CREDENTIAL_SAFE_ARTIFACTS } from "./playwright.credential-safe";

/**
 * ADR-0197 — the 2026-11-01 demo's populated-state screenshot pack (`e2e/demo-screens.spec.ts`), against a gateway
 * you have already started on a `demo:prepare` database. `.github/workflows/demo.yml` runs it after the real
 * journeys (`playwright.demo-real.config.ts`), on the database they leave behind, and uploads
 * `e2e/artifacts/demo-screens/` as the `demo-screens` artifact on every run:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3105 E2E_DEMO_PREPARE_LOG=demo-prepare.log \
 *     pnpm --filter @regulait/web exec playwright test -c playwright.demo-screens.config.ts
 *
 * The personas sign in with what demo:prepare printed (see e2e/demo-credentials.ts). 1440x900, light theme by
 * default; the spec sets its own viewport and theme on every page it opens.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3105";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["demo-screens.spec.ts"],
  timeout: 420_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    // no trace, no video: a trace keeps every typed password (playwright.credential-safe.ts)
    ...CREDENTIAL_SAFE_ARTIFACTS,
  },
});
