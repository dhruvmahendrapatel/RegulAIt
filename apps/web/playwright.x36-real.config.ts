import { defineConfig } from "@playwright/test";

/** Prepared, disposable demo database and real gateway; no HTTP route mocks. */
export default defineConfig({
  testDir: "./e2e", testMatch: "x36-batch5-real.spec.ts", workers: 1, retries: 0,
  timeout: 240_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3147", browserName: "chromium",
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
});
