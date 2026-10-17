import { defineConfig } from "@playwright/test";
import { CREDENTIAL_SAFE_ARTIFACTS } from "./playwright.credential-safe";

/** Prepared, disposable demo database and real gateway; no HTTP route mocks. */
export default defineConfig({
  testDir: "./e2e", testMatch: "demo-x36-batch5-real.spec.ts", workers: 1, retries: 0,
  timeout: 240_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3147", browserName: "chromium",
    contextOptions: { reducedMotion: "reduce" }, // e2e only: no transitions racing axe checks (global.css honours it; N9)
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1440, height: 1000 },
    // no trace, no video: a trace keeps every typed password (playwright.credential-safe.ts)
    ...CREDENTIAL_SAFE_ARTIFACTS },
});
