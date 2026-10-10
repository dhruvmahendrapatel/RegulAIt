import { defineConfig } from "@playwright/test";

/** X38 uses its own prepared disposable database and the actual gateway. */
export default defineConfig({
  testDir: "./e2e", testMatch: "demo-x38-artifacts-real.spec.ts", workers: 1, retries: 0,
  timeout: 240_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3148", browserName: "chromium",
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
});
