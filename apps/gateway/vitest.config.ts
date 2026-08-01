import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares one Postgres database; parallel workers would
    // race on migrations and seed data.
    fileParallelism: false,
    env: {
      // ADR-0031 item 4: the HTTP rate limiter is ON by default in a real
      // deployment (see rate-limit.ts). The suite drives thousands of requests
      // from one address in seconds — auth.test.ts alone deliberately fails
      // login dozens of times to exercise the ADR-0025 lockout — so it is
      // switched OFF here rather than having every future test file quietly
      // depend on staying under a limit. rate-limit.test.ts builds its own app
      // with the limiter explicitly ON, and asserts that the *default* config
      // (with an empty environment) is enabled, so the shipping posture is
      // still covered.
      REGULAIT_RATE_LIMIT: "off",
    },
  },
});
