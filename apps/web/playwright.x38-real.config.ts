import { defineConfig } from "@playwright/test";
import { CREDENTIAL_SAFE_ARTIFACTS } from "./playwright.credential-safe";

/**
 * X38 model-artifact journeys: the actual gateway on its own prepared, disposable
 * database; no HTTP route mocks. Run only explicitly (`-c playwright.x38-real.config.ts`);
 * the spec's header lists what it needs. Like the X36 config, nothing runs it by default.
 */
export default defineConfig({
  testDir: "./e2e", testMatch: "demo-x38-artifacts-real.spec.ts", workers: 1, retries: 0,
  timeout: 240_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3148", browserName: "chromium",
    contextOptions: { reducedMotion: "reduce" }, // e2e only: no transitions racing axe checks (global.css honours it; N9)
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1440, height: 1000 },
    // no trace, no video: a trace keeps every typed password (playwright.credential-safe.ts)
    ...CREDENTIAL_SAFE_ARTIFACTS },
});
