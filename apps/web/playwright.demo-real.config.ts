import { defineConfig } from "@playwright/test";

/**
 * The REAL seeded-database demo journey (`e2e/demo-intake.spec.ts`) against a
 * gateway you have already started on a `demo:prepare` database — no global
 * setup, no seeding here (the journey mutates the database: prepare a fresh one
 * for every run). Used by `.github/workflows/demo.yml` and the dry run:
 *
 *   pnpm --filter @regulait/gateway demo:prepare        # on an EMPTY database
 *   PORT=3105 pnpm --filter @regulait/gateway start      # same environment
 *   E2E_BASE_URL=http://127.0.0.1:3105 pnpm --filter @regulait/web exec \
 *     playwright test -c playwright.demo-real.config.ts
 *
 * The gateway's REGULAIT_BOOTSTRAP_TOKEN must be `e2e-bootstrap-token` (the
 * spec mints one-time passwords with it).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3105";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "demo-intake.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
});
