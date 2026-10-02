import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "demo-governance.mock.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : undefined,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx --no-install vite --host 127.0.0.1 --port 4179",
    url: "http://127.0.0.1:4179/ui/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
