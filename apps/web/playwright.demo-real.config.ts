import { defineConfig } from "@playwright/test";

/**
 * The REAL seeded-database demo journey (`e2e/demo-intake.spec.ts`), then the
 * review-policy journey (`e2e/demo-review-policy.spec.ts`), against a
 * gateway you have already started on a `demo:prepare` database — no global
 * setup, no seeding here (the journey mutates the database: prepare a fresh one
 * for every run). Used by `.github/workflows/demo.yml` and the dry run:
 *
 *   pnpm --filter @regulait/gateway demo:prepare | tee demo-prepare.log   # on an EMPTY database
 *   PORT=3105 pnpm --filter @regulait/gateway start      # same environment
 *   E2E_BASE_URL=http://127.0.0.1:3105 E2E_DEMO_PREPARE_LOG=demo-prepare.log \
 *     pnpm --filter @regulait/web exec playwright test -c playwright.demo-real.config.ts
 *
 * B4S-06: the personas sign in with the one-time passwords and Ada's
 * authenticator secret demo:prepare printed once, read from its captured output
 * (E2E_DEMO_PREPARE_LOG; see e2e/demo-credentials.ts) — the bootstrap token
 * re-provisions nobody once the seed enrolled Ada. Without that file the specs
 * fall back to the bootstrap path, which only works on a database where no
 * admin can step up yet. Export the same REGULAIT_BOOTSTRAP_TOKEN the gateway
 * was started with (it falls back to `e2e-bootstrap-token`, the CI value) for
 * the specs' read-only calls.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3105";

export default defineConfig({
  testDir: "./e2e",
  // the Monday journey first (file order), then the review-policy journey,
  // which restores the policy it sets so the journey above never sees one
  testMatch: ["demo-intake.spec.ts", "demo-review-policy.spec.ts"],
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
